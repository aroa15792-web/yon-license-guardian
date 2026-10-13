import http from 'node:http';
import path from 'node:path';
import { constants } from 'node:fs';
import { chmod, lstat, open, readFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SOCKET_PATH = '/run/yon-license-login/status-web.sock';
export const MONITOR_PATH = '/var/lib/yon-license-monitor/monitor/status.json';
export const TEST_PATH = '/var/lib/yon-license-monitor/manual-test/journal.json';
const hosts = new Set(['127.0.0.1:19080', 'localhost:19080']);
const states = new Set(['checking', 'observing', 'preview', 'released', 'cooldown', 'changed_retry_next_cycle', 'paused', 'stopped']);
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000;
const timestamp = (value, now) => Number.isSafeInteger(value) && value >= 0 && value <= now;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const unavailable = () => ({ status: 'unavailable' });

// Build new objects from safe scalars. Never forward journal identifiers,
// fingerprints, unrecognized properties or raw source/error messages.
export function sanitizeMonitor(value, now = Date.now()) {
  if (!record(value) || !states.has(value.status) || typeof value.enabled !== 'boolean' ||
      !timestamp(value.checkedAt, now)) return unavailable();
  const clean = { status: value.status, enabled: value.enabled, checkedAt: value.checkedAt };
  if (['observing', 'preview'].includes(value.status)) {
    if (value.capacity !== 10 || !count(value.used) ||
        (value.status === 'observing' && value.used >= 10) ||
        (value.status === 'preview' && (value.enabled || value.used < 10))) return unavailable();
    return { ...clean, capacity: 10, used: value.used };
  }
  if (value.status === 'released') {
    if (!value.enabled || value.capacity !== 10 || !count(value.before) || value.before < 10 ||
        !count(value.after) || value.after >= value.before || !count(value.released) ||
        value.released < 1 || value.released > value.before) return unavailable();
    return { ...clean, capacity: 10, before: value.before, after: value.after, released: value.released };
  }
  return clean;
}

export function sanitizeTest(value, now = Date.now()) {
  if (!record(value) || !['pending', 'verified'].includes(value.status) ||
      !timestamp(value.at, now) || !count(value.before) || value.before < 1) return unavailable();
  const clean = { status: value.status, checkedAt: value.at, before: value.before };
  if (value.status === 'pending') return clean;
  if (!count(value.after) || value.after >= value.before || !count(value.released) ||
      value.released < 1 || value.released > value.before) return unavailable();
  return { ...clean, after: value.after, released: value.released };
}

async function readPrivateJson(file) {
  const directory = await lstat(path.dirname(file));
  if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o7777) !== 0o700) {
    throw new Error('unavailable');
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.uid !== process.getuid() || (metadata.mode & 0o7777) !== 0o600 ||
        metadata.nlink > 1 || metadata.size > 8192) throw new Error('unavailable');
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) throw new Error('unavailable');
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

export function createStatusReader({ readJson = readPrivateJson, now = Date.now } = {}) {
  return async () => {
    const [monitor, test] = await Promise.allSettled([readJson(MONITOR_PATH), readJson(TEST_PATH)]);
    const at = now();
    return {
      monitor: monitor.status === 'fulfilled' ? sanitizeMonitor(monitor.value, at) : unavailable(),
      test: test.status === 'fulfilled' ? sanitizeTest(test.value, at)
        : test.reason?.code === 'ENOENT' ? null : unavailable(),
    };
  };
}

async function statOrNull(file) {
  try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function startStatusViewer({
  socketPath = SOCKET_PATH, readStatus = createStatusReader(),
  indexFile = fileURLToPath(new URL('./index.html', import.meta.url)),
} = {}) {
  if (!path.isAbsolute(socketPath) || typeof readStatus !== 'function') throw new Error('unavailable');
  const directory = await lstat(path.dirname(socketPath));
  if (!directory.isDirectory() || directory.uid !== process.getuid() || (directory.mode & 0o7777) !== 0o700 ||
      await statOrNull(socketPath)) throw new Error('unavailable');
  const template = await readFile(indexFile, 'utf8');
  if (!template.includes('__CSP_NONCE__')) throw new Error('unavailable');
  const server = http.createServer(async (request, response) => {
    const nonce = randomBytes(18).toString('base64');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    const send = (status, body, contentType = 'text/plain; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': contentType }); response.end(body);
    };
    if (!hosts.has(request.headers.host) || (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`)) {
      send(403, 'Forbidden'); return;
    }
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); send(405, 'Read only'); return; }
    if (!['/', '/status'].includes(request.url)) { send(404, 'Not found'); return; }
    if (request.url === '/') { send(200, template.replaceAll('__CSP_NONCE__', nonce), 'text/html; charset=utf-8'); return; }
    try { send(200, JSON.stringify(await readStatus()), 'application/json; charset=utf-8'); }
    catch { send(503, JSON.stringify({ monitor: unavailable(), test: unavailable() }), 'application/json; charset=utf-8'); }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  server.on('upgrade', (_, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  let identity;
  try {
    await chmod(socketPath, 0o600);
    identity = await lstat(socketPath);
  } catch (error) { server.close(); throw error; }
  let closing;
  return { close() {
    closing ??= (async () => {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      const current = await statOrNull(socketPath);
      if (current?.isSocket() && current.uid === process.getuid() && current.dev === identity.dev && current.ino === identity.ino) {
        await unlink(socketPath);
      }
    })();
    return closing;
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  startStatusViewer().then(service => {
    const stop = () => { void service.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }).catch(() => {
    console.error(JSON.stringify({ status: 'status_viewer_unavailable' }));
    process.exitCode = 1;
  });
}
