import http from 'node:http';
import { realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { FileJournal } from './file-journal.mjs';
import { fingerprint, validate } from './policy.mjs';
import { createReleaseMonitor, createReleaseStatusWriter } from './release-monitor.mjs';
import { SOCKET_PATH, STATUS_DIRECTORY } from './summary-monitor.mjs';

class RpcError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// Fixed Unix RPC only. No credential inspection or automatic request retry.
export function callLicenseRpc(path, operation, { request = http.request } = {}) {
  if (!['/snapshot', '/release'].includes(path) || (path === '/release') !== !!operation) throw new RpcError('invalid_operation');
  return new Promise((resolve, reject) => {
    let settled = false, req, timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { req?.destroy(); reject(error); } else resolve(value);
    };
    timer = setTimeout(() => finish(new RpcError('timeout')), 40_000);
    try {
    req = request({ socketPath: SOCKET_PATH, path, method: operation ? 'POST' : 'GET', agent: false,
      headers: { Accept: 'application/json', Connection: 'close',
        ...(operation ? { 'Content-Type': 'application/json' } : {}) },
    }, res => {
      const chunks = []; let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 131072) { res.destroy(); finish(new RpcError('invalid_response')); }
        else chunks.push(chunk);
      });
      res.on('error', () => finish(new RpcError('transport_error')));
      res.on('aborted', () => finish(new RpcError('transport_error')));
      res.on('end', () => {
        let result;
        try { result = JSON.parse(Buffer.concat(chunks).toString()); }
        catch { finish(new RpcError('invalid_response')); return; }
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          finish(new RpcError('invalid_response')); return;
        }
        if (!/^application\/json(?:;|$)/i.test(res.headers['content-type'] ?? '')) {
          finish(new RpcError('invalid_response')); return;
        }
        if (res.statusCode === 401 || result.status === 'needs_login') return finish(new RpcError('needs_login'));
        if (res.statusCode === 403 || result.status === 'access_denied') return finish(new RpcError('access_denied'));
        if (res.statusCode !== 200 || !['ok', 'acknowledged'].includes(result.status)) {
          const known = ['wrong_tenant', 'wrong_target', 'snapshot_changed', 'incomplete_list', 'timeout', 'reconciliation_required'];
          finish(new RpcError(known.includes(result.code) ? result.code : 'invalid_response')); return;
        }
        finish(null, result);
      });
    });
    req.on('error', () => finish(new RpcError('transport_error')));
    req.end(operation ? JSON.stringify(operation) : undefined);
    } catch { finish(new RpcError('transport_error')); }
  });
}

export function createLiveAdapter({
  rpc = callLicenseRpc, now = Date.now,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  let pendingVerification;
  const readSnapshot = async () => {
    const result = await rpc('/snapshot');
    if (result.status !== 'ok') throw new RpcError('invalid_response');
    return validate(result.snapshot, now());
  };
  const reconcile = async expected => {
    const deadline = now() + 30_000;
    let expired = false;
    let timer;
    const checkDeadline = () => {
      if (expired || now() >= deadline) throw new RpcError('reconciliation_required');
    };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new RpcError('reconciliation_required'));
      }, 30_000);
    });
    const verify = async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        checkDeadline();
        let current;
        try {
          current = await readSnapshot();
        } catch (error) {
          checkDeadline();
          if (error?.code !== 'snapshot_changed') throw error;
        }
        checkDeadline();
        if (current) {
          if (current.tenantKey !== expected.tenantKey) throw new RpcError('wrong_tenant');
          if (current.used < expected.before &&
              current.records.every(row => !expected.ids.has(row.id))) return current;
        }
        if (attempt < 4) {
          await sleep(Math.min(1_000 * 2 ** attempt, deadline - now()));
        }
      }
      throw new RpcError('reconciliation_required');
    };
    try {
      // Only reads race this deadline. A late response cannot start another
      // attempt, and neither a failed verification nor a retry sends a POST.
      return await Promise.race([verify(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  const read = async () => {
    if (!pendingVerification) return readSnapshot();
    const expected = pendingVerification;
    // Cache failure as well as the in-flight check: pending remains unresolved
    // until external reconciliation, even if read() is called again.
    expected.promise ??= reconcile(expected).then(current => {
      pendingVerification = undefined;
      return current;
    });
    return expected.promise;
  };
  return {
    read,
    async release(operation) {
      if (pendingVerification) throw new RpcError('reconciliation_required');
      // pending is already durable. Recheck the entire selection before sending.
      const current = await readSnapshot();
      if (current.tenantKey !== operation.tenantKey || fingerprint(current) !== operation.expectedFingerprint ||
          JSON.stringify(current.records.map(row => row.id).sort()) !== JSON.stringify([...operation.ids].sort())) {
        throw new RpcError('snapshot_changed');
      }
      const expected = { ids: new Set(operation.ids), before: operation.ids.length, tenantKey: operation.tenantKey };
      const result = await rpc('/release', operation);
      if (result.status !== 'acknowledged') throw new RpcError('reconciliation_required');
      pendingVerification = expected;
      return { status: 'acknowledged' };
    },
  };
}

export async function run() {
  if (process.env.YON_AUTO_RELEASE !== '1') throw new RpcError('release_disabled');
  process.umask(0o077);
  const state = await realpath('/var/lib/yon-license-monitor');
  const manualJournal = new FileJournal({ directory: `${state}/manual-test` });
  const manual = await manualJournal.read();
  // An ambiguous explicit test must pause automatic writes too. The existing
  // controller pauses on pending before reading or writing; it cannot overwrite
  // that journal without external reconciliation.
  const journal = manual?.status === 'pending' ? manualJournal
    : new FileJournal({ directory: `${state}/journal` });
  const monitor = createReleaseMonitor({
    adapter: createLiveAdapter(), journal, enabled: true,
    writeStatus: createReleaseStatusWriter({ directory: STATUS_DIRECTORY }),
  });
  const stop = () => { void monitor.stop().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  await monitor.start();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(() => {
    console.error(JSON.stringify({ status: 'startup_failed' }));
    process.exitCode = 1;
  });
}
