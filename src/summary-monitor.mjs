import http from 'node:http';
import { constants } from 'node:fs';
import { lstat, mkdir, chmod, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const INTERVAL_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 20_000;
export const MAX_RESPONSE_BYTES = 8 * 1024;
export const SOCKET_PATH = '/run/yon-license-login/browser-control.sock';
export const STATUS_DIRECTORY = '/var/lib/yon-license-monitor/monitor';
export const STATUS_PATH = `${STATUS_DIRECTORY}/status.json`;
const SOCKET_DIRECTORY = '/run/yon-license-login';
const ERROR_CODES = new Set([
  'invalid_response', 'wrong_target', 'invalid_count', 'http_error',
  'redirect', 'timeout', 'transport_error', 'unknown', 'wrong_tenant',
]);

export class MonitorError extends Error {
  constructor(code, pauseReason) {
    super(code);
    this.code = code;
    if (pauseReason) this.pauseReason = pauseReason;
  }
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

// Only the redacted response contract of our local browser service is accepted.
// This does not establish tenant identity or authorize any licence release.
export function validateResponse({ statusCode, headers, body }, now = Date.now()) {
  const pauseReason = statusCode === 401 ? 'needs_login' : statusCode === 403 ? 'access_denied' : undefined;
  const invalid = () => { throw new MonitorError('invalid_response', pauseReason); };
  const contentType = headers?.['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType) ||
      (headers?.['content-encoding'] !== undefined && headers['content-encoding'] !== 'identity')) invalid();
  if (typeof body !== 'string' && !Buffer.isBuffer(body)) invalid();
  if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new MonitorError('response_too_large', pauseReason);
  let value;
  try { value = JSON.parse(body.toString()); } catch { invalid(); }
  if (statusCode === 401 || statusCode === 403) {
    if (!exactKeys(value, ['status']) || value.status !== pauseReason) invalid();
    return { status: pauseReason };
  }
  if (statusCode === 200 && exactKeys(value, ['status', 'summary']) && value.status === 'ok') {
    const s = value.summary;
    if (!exactKeys(s, ['kind', 'capacity', 'used', 'full', 'observedAt']) ||
        s.kind !== 'procurement-license-summary' || s.capacity !== 10 ||
        !Number.isSafeInteger(s.used) || s.used < 0 || s.full !== (s.used >= 10) ||
        !Number.isSafeInteger(s.observedAt) || s.observedAt < 0 ||
        !Number.isSafeInteger(now) || s.observedAt > now || now - s.observedAt > 30_000) invalid();
    return { status: 'ok', summary: { kind: s.kind, capacity: 10, used: s.used, full: s.full, observedAt: s.observedAt } };
  }
  if (exactKeys(value, ['status', 'code']) && value.status === 'error' &&
      ((statusCode === 409 && value.code === 'busy') ||
       (statusCode === 504 && value.code === 'timeout') ||
       (statusCode === 502 && ERROR_CODES.has(value.code) && value.code !== 'timeout'))) {
    return { status: 'error', code: value.code };
  }
  invalid();
}

async function checkSocket(stat, uid) {
  const directory = await stat(SOCKET_DIRECTORY);
  const socket = await stat(SOCKET_PATH);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== uid ||
      (directory.mode & 0o777) !== 0o700 || !socket.isSocket() || socket.isSymbolicLink() ||
      socket.uid !== uid || (socket.mode & 0o777) !== 0o600) throw new MonitorError('unsafe_socket');
}

export function createUnixSummaryReader({
  request = http.request, stat = lstat, uid = process.getuid(), now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  return async ({ signal } = {}) => {
    try { await checkSocket(stat, uid); } catch (error) {
      if (error instanceof MonitorError) throw error;
      throw new MonitorError(error.code === 'ENOENT' ? 'unavailable' : 'transport_error');
    }
    if (signal?.aborted) throw new MonitorError('aborted');
    return new Promise((resolve, reject) => {
      let req;
      let res;
      let settled = false;
      let timer;
      let pauseReason;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimer(timer);
        signal?.removeEventListener('abort', abort);
        if (error) {
          res?.destroy(); req?.destroy();
          reject(pauseReason && error.code !== 'aborted' ? new MonitorError(error.code, pauseReason) : error);
        } else resolve(result);
      };
      const abort = () => finish(new MonitorError('aborted'));
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimer(() => finish(new MonitorError('timeout')), REQUEST_TIMEOUT_MS);
      try {
        req = request({
          socketPath: SOCKET_PATH, path: '/summary', method: 'GET', agent: false,
          headers: { Accept: 'application/json', Connection: 'close' },
          maxHeaderSize: MAX_RESPONSE_BYTES,
        }, response => {
          res = response;
          if (settled) { res.destroy(); return; }
          const auth = res.statusCode === 401 ? 'needs_login' : res.statusCode === 403 ? 'access_denied' : undefined;
          pauseReason = auth;
          const length = res.headers['content-length'];
          if (length !== undefined && (!/^\d+$/.test(String(length)) || Number(length) > MAX_RESPONSE_BYTES)) {
            finish(new MonitorError('response_too_large', auth)); return;
          }
          const chunks = [];
          let bytes = 0;
          res.on('data', chunk => {
            if (settled) return;
            bytes += Buffer.byteLength(chunk);
            if (bytes > MAX_RESPONSE_BYTES) { finish(new MonitorError('response_too_large', auth)); return; }
            chunks.push(Buffer.from(chunk));
          });
          res.on('error', () => finish(new MonitorError('transport_error', auth)));
          res.on('aborted', () => finish(new MonitorError('transport_error', auth)));
          res.on('end', () => {
            if (settled) return;
            try { finish(null, validateResponse({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }, now())); }
            catch (error) { finish(error instanceof MonitorError ? error : new MonitorError('invalid_response', auth)); }
          });
        });
        req.on('error', () => finish(new MonitorError('transport_error')));
        req.end();
      } catch { finish(new MonitorError('transport_error')); }
    });
  };
}

async function optionalStat(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function safeDirectory(info, uid) {
  if (!info?.isDirectory() || info.isSymbolicLink() || info.uid !== uid) throw new MonitorError('unsafe_status_directory');
}

function safeFile(info, uid) {
  if (info && (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || info.nlink !== 1)) {
    throw new MonitorError('unsafe_status_file');
  }
}

// The profile's parent may be systemd's StateDirectory symlink. The monitor
// directory and its files must themselves be owned, private and non-symlinks.
export function createStatusWriter({ directory = STATUS_DIRECTORY, uid = process.getuid() } = {}) {
  return async state => {
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    const before = await lstat(directory);
    safeDirectory(before, uid);
    await chmod(directory, 0o700);
    const target = `${directory}/status.json`;
    safeFile(await optionalStat(target), uid);
    const temporary = `${directory}/.status-${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      const after = await lstat(directory);
      safeDirectory(after, uid);
      if (before.dev !== after.dev || before.ino !== after.ino || (after.mode & 0o777) !== 0o700) {
        throw new MonitorError('unsafe_status_directory');
      }
      safeFile(await optionalStat(target), uid);
      await rename(temporary, target);
    } finally {
      await handle?.close();
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  };
}

export function createSummaryMonitor({
  readSummary = createUnixSummaryReader(), writeStatus = createStatusWriter(), now = Date.now,
  log = value => console.log(JSON.stringify(value)),
  setEvery = setInterval, clearEvery = clearInterval,
} = {}) {
  let cycle = 0;
  let timer;
  let active;
  let controller;
  let started = false;
  let stopped = false;
  let paused = false;
  let lastSuccess;
  let state;
  const haltTimer = () => { if (timer !== undefined) clearEvery(timer); timer = undefined; };
  const tick = () => {
    if (active) return active;
    if (stopped || paused) return Promise.resolve(state);
    active = (async () => {
      cycle++;
      controller = new AbortController();
      let result;
      let failure;
      try { result = await readSummary({ signal: controller.signal }); }
      catch (error) { failure = error instanceof MonitorError ? error : new MonitorError('transport_error'); }
      if (stopped) return state;
      const checkedAt = now();
      const reason = failure?.pauseReason ?? (result?.status === 'needs_login' || result?.status === 'access_denied' ? result.status : undefined);
      if (reason) {
        paused = true; haltTimer();
        state = { status: 'paused', reason, checkedAt, cycle };
      } else if (result?.status === 'error' && result.code === 'wrong_tenant') {
        paused = true; haltTimer();
        state = { status: 'paused_scope_mismatch', checkedAt, cycle };
      } else if (result?.status === 'ok') {
        const s = result.summary;
        // Check freshness again at the point at which the result is published.
        try {
          validateResponse({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(result) }, checkedAt);
          lastSuccess = { used: s.used, capacity: s.capacity, full: s.full, checkedAt, sourceObservedAt: s.observedAt };
          state = { status: s.full ? 'needs_release_validation' : 'observing', ...lastSuccess, cycle };
        } catch { state = { status: 'unavailable', checkedAt, cycle }; }
      } else state = { status: 'unavailable', checkedAt, cycle };
      // Old values have a separate, explicitly historical location, never current counts.
      if (lastSuccess) state.lastSuccess = { ...lastSuccess };
      try { await writeStatus(state); } catch {
        paused = true; haltTimer();
        state = { status: 'paused', reason: 'status_write_failed', checkedAt, cycle, ...(lastSuccess ? { lastSuccess: { ...lastSuccess } } : {}) };
      }
      const entry = { status: state.status, checkedAt, cycle };
      for (const key of ['used', 'capacity', 'full', 'sourceObservedAt']) if (Object.hasOwn(state, key)) entry[key] = state[key];
      log(entry);
      return state;
    })().finally(() => { active = undefined; controller = undefined; });
    return active;
  };
  return {
    tick,
    start() {
      if (started || stopped) return active ?? Promise.resolve(state);
      started = true;
      timer = setEvery(() => { void tick().catch(() => { paused = true; haltTimer(); }); }, INTERVAL_MS);
      return tick();
    },
    async stop() { stopped = true; haltTimer(); controller?.abort(); await active; },
    getState: () => state ? structuredClone(state) : undefined,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const monitor = createSummaryMonitor();
  // Remain idle after an authentication/scope pause. Exiting here could make a
  // supervising process restart the browser and inadvertently resume requests.
  // This timer never reads the socket; only explicit restart resumes monitoring.
  const lifetime = setInterval(() => {}, INTERVAL_MS);
  const stop = () => {
    clearInterval(lifetime);
    monitor.stop().catch(() => { process.exitCode = 1; });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  monitor.start().catch(() => { process.exitCode = 1; stop(); });
}
