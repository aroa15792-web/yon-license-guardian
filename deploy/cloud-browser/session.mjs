import http from 'node:http';
import net from 'node:net';
import { lstat, mkdir, chmod, readFile, unlink, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { buildTenantScopeEvaluation, sanitizeTenantScope } from './tenant-scope.mjs';
import { buildReadSnapshotEvaluation, sanitizeReadSnapshot } from './license-adapter.mjs';
import { buildReleaseEvaluation } from './release-operation.mjs';
import { plan } from '../../src/policy.mjs';
import { FileJournal } from '../../src/file-journal.mjs';
import { ensureCloudLogin } from './auto-login.mjs';

const ORIGIN = 'https://c3.yonyoucloud.com';
const SUMMARY_URL = `${ORIGIN}/iuap-apcom-workbench/manager/license/getTenantLicenseInfo?labelDomain=MM&status=VALID`;
const SOURCE_PATH = '/opt/yon-license-monitor/src/license-summary.mjs';
const PROFILE_PATH = '/var/lib/yon-license-monitor/chrome-profile';
const SOCKET_DIR = '/run/yon-license-login';
const SOCKET_PATH = `${SOCKET_DIR}/browser-control.sock`;
const ERROR_CODES = new Set([
  'invalid_response', 'wrong_target', 'invalid_count', 'http_error',
  'redirect', 'timeout', 'transport_error', 'unknown', 'wrong_tenant',
]);

class SessionError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function browserMode(value = 'summary') {
  if (value !== 'summary' && value !== 'login') throw new SessionError('invalid_mode');
  return value;
}

export function buildSummaryEvaluation(source, { expectedTenantHash = '' } = {}) {
  if (expectedTenantHash && !/^[a-f0-9]{64}$/.test(expectedTenantHash)) throw new SessionError('invalid_tenant_hash');
  const inline = source.replace(/^export (?=(?:const|class|function)\b)/gm, '');
  if (/^\s*(?:import|export)\b/m.test(inline)) throw new SessionError('invalid_summary_source');
  return `(async () => {
    if (location.origin !== ${JSON.stringify(ORIGIN)}) return { status: 'needs_login' };
    ${expectedTenantHash ? `const scopeResult = await (${buildTenantScopeEvaluation()});
    if (scopeResult.status !== 'ok') return scopeResult;
    if (scopeResult.scope.tenantHash !== ${JSON.stringify(expectedTenantHash)}) return { status: 'error', code: 'wrong_tenant' };` : ''}
    ${inline}
    let authFailure;
    try {
      const client = createLicenseSummaryClient({
        transport: async (url, options) => {
          const response = await fetch(url, {
            ...options, credentials: 'same-origin',
            headers: { Accept: 'application/json', isAjax: '1' },
          });
          if (response.status === 401) authFailure = 'needs_login';
          if (response.status === 403) authFailure = 'access_denied';
          return {
            status: response.status, url: response.url,
            redirected: response.redirected, type: response.type, headers: response.headers,
            json: async () => {
              const body = await response.json();
              if (body?.needrelogin === true || body?.errorCode === '000001') authFailure = 'needs_login';
              return body;
            },
          };
        },
      });
      const summary = await client.read();
      if (authFailure) return { status: authFailure };
      return { status: 'ok', summary: {
        kind: summary.kind, capacity: summary.capacity, used: summary.used,
        full: summary.full, observedAt: summary.observedAt,
      } };
    } catch (error) {
      if (authFailure) return { status: authFailure };
      return { status: 'error', code: error instanceof LicenseSummaryError ? error.code : 'unknown' };
    }
  })()`;
}

// Do not forward arbitrary browser values, raw errors, source URLs or identities.
export function sanitizeResult(value) {
  if (value?.status === 'needs_login' || value?.status === 'access_denied') {
    return { status: value.status };
  }
  if (value?.status === 'ok') {
    const s = value.summary;
    if (s?.kind === 'procurement-license-summary' && s.capacity === 10 &&
        Number.isSafeInteger(s.used) && s.used >= 0 && s.full === (s.used >= 10) &&
        Number.isSafeInteger(s.observedAt) && s.observedAt >= 0) {
      return { status: 'ok', summary: {
        kind: s.kind, capacity: s.capacity, used: s.used,
        full: s.full, observedAt: s.observedAt,
      } };
    }
    return { status: 'error', code: 'invalid_response' };
  }
  return { status: 'error', code: ERROR_CODES.has(value?.code) ? value.code : 'unknown' };
}

function c3Frame(context) {
  for (const page of context.pages()) {
    for (const frame of page.frames()) {
      try { if (new URL(frame.url()).origin === ORIGIN) return frame; } catch { /* Not a URL. */ }
    }
  }
  return null;
}

function send(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
  });
  res.end(JSON.stringify(body));
}

export function createSummaryHandler(context, script, {
  timeoutMs = 35_000, scopeScript = buildTenantScopeEvaluation(),
  snapshotScript, expectedTenantHash = '', releaseEnabled = false, pendingJournal, recoverLogin,
} = {}) {
  let reading = null;
  let latestRead = null;
  const attemptedOperations = new Map();
  return async (req, res) => {
    if (!['/summary', '/scope', '/snapshot', '/release'].includes(req.url)) return send(res, 404, { status: 'error', code: 'not_found' });
    const isRelease = req.url === '/release';
    if (req.method !== (isRelease ? 'POST' : 'GET')) return send(res, 405, { status: 'error', code: 'method_not_allowed' });
    if (isRelease && !releaseEnabled) return send(res, 403, { status: 'error', code: 'release_disabled' });
    if (req.url === '/snapshot' && !snapshotScript) return send(res, 503, { status: 'error', code: 'unavailable' });
    if (reading) return send(res, 409, { status: 'error', code: 'busy' });
    let frame;
    try { frame = c3Frame(context); } catch { return send(res, 502, { status: 'error', code: 'unknown' }); }
    if (!frame && (isRelease || !recoverLogin)) return send(res, 401, { status: 'needs_login' });
    let requestTimedOut = false;

    // Keep this lock until evaluate settles, even after the HTTP deadline. A
    // frozen browser must not accumulate further evaluations on later requests.
    const scopeRequest = req.url === '/scope';
    const snapshotRequest = req.url === '/snapshot';
    reading = Promise.resolve().then(async () => {
      if (isRelease) {
        // Same-UID Unix socket is the only entry. Also require the exact durable
        // pending journal written by our controller before any remote mutation.
        let raw = '';
        for await (const chunk of req) {
          raw += chunk.toString();
          if (Buffer.byteLength(raw) > 8192) return { status: 'error', code: 'invalid_operation' };
        }
        let op;
        try { op = JSON.parse(raw); } catch { return { status: 'error', code: 'invalid_operation' }; }
        if (!op || Object.keys(op).sort().join(',') !== 'expectedFingerprint,ids,operationId,tenantKey' ||
            !Array.isArray(op.ids) || op.ids.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) ||
            new Set(op.ids).size !== op.ids.length || op.tenantKey !== expectedTenantHash ||
            typeof op.operationId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(op.operationId) ||
            !latestRead || Date.now() - latestRead.snapshot.observedAt > 30000) return { status: 'error', code: 'invalid_operation' };
        try {
          const selection = plan(latestRead.snapshot);
          if (selection.action !== 'release' || selection.fingerprint !== op.expectedFingerprint ||
              JSON.stringify([...op.ids].sort()) !== JSON.stringify([...selection.ids].sort())) throw new Error();
          const journal = await pendingJournal?.read();
          if (!journal || journal.status !== 'pending' || journal.operationId !== op.operationId ||
              journal.fingerprint !== op.expectedFingerprint || journal.before !== latestRead.snapshot.used ||
              Date.now() - journal.at > 30000 || journal.at > Date.now()) throw new Error();
        } catch { return { status: 'error', code: 'invalid_operation' }; }
        for (const [id, at] of attemptedOperations) if (Date.now() - at > 60_000) attemptedOperations.delete(id);
        if (requestTimedOut || res.destroyed || attemptedOperations.has(op.operationId)) return { status: 'error', code: 'invalid_operation' };
        const token = latestRead.token;
        latestRead = null;
        attemptedOperations.set(op.operationId, Date.now());
        return frame.evaluate(buildReleaseEvaluation({ token, ...op }));
      }
      const readScript = snapshotRequest ? snapshotScript : scopeRequest ? scopeScript : script;
      let result = frame ? await frame.evaluate(readScript) : { status: 'needs_login' };
      // Only a read may restore authentication. Never retry a licence mutation,
      // nor carry its old token across a changed login session.
      if (result?.status === 'needs_login' && recoverLogin && !requestTimedOut) {
        latestRead = null;
        const recovery = await recoverLogin();
        if (recovery?.status !== 'ok') return recovery?.code === 'wrong_tenant'
          ? { status: 'error', code: 'wrong_tenant' } : { status: 'needs_login' };
        if (requestTimedOut || res.destroyed) return { status: 'error', code: 'timeout' };
        frame = c3Frame(context);
        result = frame ? await frame.evaluate(readScript) : { status: 'needs_login' };
      }
      if (snapshotRequest) {
        const clean = sanitizeReadSnapshot(result, { expectedTenantHash });
        latestRead = clean.status === 'ok' ? clean : null;
        return clean;
      }
      return scopeRequest ? sanitizeTenantScope(result) : sanitizeResult(result);
    }).catch(() => ({ status: 'error', code: 'unknown' }));
    const operation = reading;
    operation.finally(() => { if (reading === operation) reading = null; });
    let timer;
    try {
      const result = await Promise.race([
        operation,
        new Promise(resolve => {
          timer = setTimeout(() => { requestTimedOut = true; resolve({ status: 'error', code: 'timeout' }); }, timeoutMs);
        }),
      ]);
      const status = ['ok','acknowledged'].includes(result.status) ? 200 : result.status === 'needs_login' ? 401 :
        result.status === 'access_denied' ? 403 : result.code === 'timeout' ? 504 : 502;
      if (!res.destroyed) send(res, status, result);
    } finally { clearTimeout(timer); }
  };
}

async function statOrNull(path) {
  try { return await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function prepareSocket() {
  await mkdir(SOCKET_DIR, { recursive: true, mode: 0o700 });
  const directory = await lstat(SOCKET_DIR);
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.getuid()) {
    throw new SessionError('unsafe_socket_directory');
  }
  await chmod(SOCKET_DIR, 0o700);
  const existing = await statOrNull(SOCKET_PATH);
  if (!existing) return;
  if (!existing.isSocket() || existing.uid !== process.getuid()) throw new SessionError('unsafe_socket_path');
  const stale = await new Promise(resolve => {
    const probe = net.createConnection(SOCKET_PATH);
    const finish = result => { probe.destroy(); resolve(result); };
    probe.once('connect', () => finish(false));
    probe.once('error', error => finish(error.code === 'ECONNREFUSED' || error.code === 'ENOENT'));
    probe.setTimeout(1000, () => finish(false));
  });
  if (!stale) throw new SessionError('socket_in_use');
  const current = await statOrNull(SOCKET_PATH);
  if (!current) return;
  if (!current.isSocket() || current.uid !== process.getuid() ||
      current.ino !== existing.ino || current.dev !== existing.dev) throw new SessionError('socket_changed');
  await unlink(SOCKET_PATH);
}

export async function start() {
  process.umask(0o077);
  const mode = browserMode(process.env.YON_BROWSER_MODE ?? 'summary');
  const headless = process.env.YON_BROWSER_HEADLESS === '1';
  if (headless && mode !== 'summary') throw new SessionError('invalid_mode');
  const script = buildSummaryEvaluation(await readFile(SOURCE_PATH, 'utf8'), {
    expectedTenantHash: process.env.YON_TENANT_HASH ?? '',
  });
  const snapshotScript = process.env.YON_TENANT_HASH ? buildReadSnapshotEvaluation({
    expectedTenantHash: process.env.YON_TENANT_HASH, summarySource: await readFile(SOURCE_PATH, 'utf8'),
  }) : null;
  const releaseEnabled = process.env.YON_AUTO_RELEASE === '1';
  const pendingJournal = releaseEnabled ? new FileJournal({
    directory: (await realpath('/var/lib/yon-license-monitor')) + '/journal',
  }) : null;
  await prepareSocket();
  let context;
  let server;
  let socketIdentity;
  let stopping = false;
  let shutdownPromise;
  const shutdown = () => {
    stopping = true;
    // Serialize, but re-run cleanup for resources created while an earlier
    // signal handler was waiting. Startup checks call this again after awaits.
    shutdownPromise = (shutdownPromise ?? Promise.resolve()).catch(() => {}).then(async () => {
      if (server) {
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      }
      if (context) await context.close();
      const current = await statOrNull(SOCKET_PATH);
      if (socketIdentity && current?.isSocket() && current.uid === process.getuid() &&
          current.ino === socketIdentity.ino && current.dev === socketIdentity.dev) await unlink(SOCKET_PATH);
    });
    return shutdownPromise;
  };
  const signalHandler = () => { shutdown().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', signalHandler);
  process.once('SIGINT', signalHandler);
  try {
    const { chromium } = await import('playwright-core');
    context = await chromium.launchPersistentContext(PROFILE_PATH, {
      executablePath: '/usr/bin/google-chrome',
      headless,
      chromiumSandbox: true,
      viewport: null,
      handleSIGTERM: false,
      handleSIGINT: false,
      handleSIGHUP: false,
      args: [
        '--window-size=1280,900', '--window-position=0,0', '--lang=zh-CN',
        '--disable-sync', '--disable-background-networking',
        '--disable-component-update', '--disable-default-apps', '--disable-dev-shm-usage',
        '--no-first-run', '--no-default-browser-check',
      ],
    });
    if (stopping) { await shutdown(); return; }
    const page = context.pages()[0] ?? await context.newPage();
    for (const other of context.pages()) if (other !== page) await other.close();
    try {
      await page.goto(mode === 'summary' ? SUMMARY_URL : 'https://www.yonyoucloud.com/', {
        waitUntil: 'domcontentloaded', timeout: 30_000,
      });
    } catch {
      // A failed navigation is not authentication success. The socket remains
      // available to report needs_login/unknown; no automatic navigation retry.
    }
    if (stopping) { await shutdown(); return; }
    let lastLoginAttempt = -Infinity;
    const recoverLogin = process.env.YON_AUTO_LOGIN === '1' ? async () => {
      const now = Date.now();
      if (now - lastLoginAttempt < 600_000) return { status: 'needs_login' };
      lastLoginAttempt = now;
      const result = await ensureCloudLogin(context, { expectedTenantHash: process.env.YON_TENANT_HASH ?? '' });
      console.log(JSON.stringify({ status: 'authentication', result: result.status,
        ...(result.code ? { code: result.code } : {}), ...(result.phase ? { phase: result.phase } : {}) }));
      return result;
    } : undefined;
    server = http.createServer(createSummaryHandler(context, script, { snapshotScript,
      expectedTenantHash: process.env.YON_TENANT_HASH ?? '', releaseEnabled, pendingJournal, recoverLogin }));
    server.requestTimeout = 45_000;
    server.headersTimeout = 10_000;
    server.on('clientError', (_error, socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(SOCKET_PATH, resolve);
    });
    await chmod(SOCKET_PATH, 0o600);
    socketIdentity = await lstat(SOCKET_PATH);
    if (stopping) { await shutdown(); return; }
    console.log(JSON.stringify({ status: 'ready', mode, headless, tenantPinned: !!process.env.YON_TENANT_HASH }));
  } catch (error) {
    await shutdown();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().catch(error => {
    console.error(JSON.stringify({ status: 'error', code: error instanceof SessionError ? error.code : 'startup_failed' }));
    process.exitCode = 1;
  });
}
