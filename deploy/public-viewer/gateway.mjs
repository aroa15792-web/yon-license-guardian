import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { validateStatus } from './event-contract.mjs';
import { createEventStore, EVENT_DIRECTORY } from './event-store.mjs';
import { createEventCollector, COLLECTION_INTERVAL_MS } from './event-collector.mjs';

export { validateStatus } from './event-contract.mjs';

export const HOST = '127.0.0.1';
export const PORT = 3105;
export const SOCKET_PATH = '/run/yon-license-login/status-web.sock';
export const UPSTREAM_HOST = '127.0.0.1:19080';
export const MAX_RESPONSE_BYTES = 65_536;
export const UPSTREAM_TIMEOUT_MS = 5_000;
const originalFetch = "fetch('/status', {cache:'no-store',credentials:'omit',signal:abort.signal})";
const publicFetch = "fetch('./status', {cache:'no-store',credentials:'same-origin',signal:abort.signal})";
const occurrences = (value, needle) => value.split(needle).length - 1;
const makeCsp = nonce => `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;

function validateCsp(csp) {
  if (typeof csp !== 'string') throw new Error('upstream_unavailable');
  const nonce = csp.match(/script-src 'nonce-([A-Za-z0-9+/]{16,96}={0,2})'/)?.[1];
  const expected = makeCsp(nonce);
  if (!nonce || csp !== expected) throw new Error('upstream_unavailable');
  return nonce;
}

// Recognize the current, nonce-protected status page exactly at the two affected
// tokens. A changed template fails closed instead of broadly rewriting script.
export function rewriteIndex(html, csp) {
  const nonce = validateCsp(csp);
  const nonces = Array.from(html.matchAll(/\bnonce="([^"]*)"/g), match => match[1]);
  if (occurrences(html, "fetch('/status'") !== 1 || occurrences(html, "credentials:'omit'") !== 1 ||
      occurrences(html, originalFetch) !== 1 || occurrences(html, publicFetch) !== 0 ||
      occurrences(html, `<style nonce="${nonce}">`) !== 1 ||
      occurrences(html, `<script nonce="${nonce}">`) !== 1 ||
      nonces.length !== 2 || nonces.some(value => value !== nonce)) throw new Error('upstream_unavailable');
  return html.replace(originalFetch, publicFetch);
}

async function readIndexTemplate(indexFile, maxResponseBytes) {
  const handle = await open(indexFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxResponseBytes) throw new Error('invalid_index_template');
    const buffer = Buffer.alloc(maxResponseBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxResponseBytes) throw new Error('invalid_index_template');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally { await handle.close(); }
}

function renderIndex(template, maxResponseBytes) {
  if (typeof template !== 'string' || occurrences(template, '__CSP_NONCE__') !== 2 ||
      Buffer.byteLength(template, 'utf8') > maxResponseBytes) throw new Error('invalid_index_template');
  const nonce = randomBytes(18).toString('base64');
  const csp = makeCsp(nonce);
  const body = rewriteIndex(template.replaceAll('__CSP_NONCE__', nonce), csp);
  if (Buffer.byteLength(body, 'utf8') > maxResponseBytes) throw new Error('invalid_index_template');
  return { body, csp };
}

function readUpstream({ socketPath, upstreamTimeoutMs, maxResponseBytes, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let upstream;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) { upstream?.destroy(); request.destroy(); reject(new Error('upstream_unavailable')); }
      else resolve(value);
    };
    // These are the complete upstream headers. Never copy any client headers,
    // especially Authorization, Cookie, Origin, forwarding or proxy headers.
    const request = http.request({ socketPath, path: '/status', method: 'GET', signal,
      headers: { Host: UPSTREAM_HOST, Connection: 'close', 'Accept-Encoding': 'identity',
        Accept: 'application/json' } }, response => {
      upstream = response;
      if (response.statusCode !== 200 || response.headers['content-encoding']) { finish(new Error()); return; }
      const expectedType = 'application/json; charset=utf-8';
      if (response.headers['content-type']?.toLowerCase() !== expectedType) { finish(new Error()); return; }
      const length = response.headers['content-length'];
      if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxResponseBytes)) {
        finish(new Error()); return;
      }
      const chunks = [];
      let bytes = 0;
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > maxResponseBytes) { finish(new Error()); return; }
        chunks.push(chunk);
      });
      response.on('error', finish);
      response.on('aborted', () => finish(new Error()));
      response.on('end', () => {
        if (!response.complete) { finish(new Error()); return; }
        try {
          const csp = response.headers['content-security-policy'];
          validateCsp(csp);
          const body = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          const value = JSON.parse(body);
          if (!validateStatus(value)) throw new Error('upstream_unavailable');
          if (Buffer.byteLength(body, 'utf8') > maxResponseBytes) throw new Error('upstream_unavailable');
          finish(null, { body, contentType: expectedType, csp, value });
        } catch { finish(new Error()); }
      });
    });
    // A wall-clock deadline also bounds a slow response that keeps sending bytes.
    const deadline = setTimeout(() => finish(new Error()), upstreamTimeoutMs);
    request.on('error', finish);
    request.end();
  });
}

export async function startPublicViewer({
  port = PORT, socketPath = SOCKET_PATH, upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES, indexFile = new URL('./index.html', import.meta.url), template,
  eventDirectory, collectionIntervalMs = COLLECTION_INTERVAL_MS,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65_535 || typeof socketPath !== 'string' ||
      !socketPath.startsWith('/') || !Number.isSafeInteger(upstreamTimeoutMs) || upstreamTimeoutMs < 1 ||
      !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > MAX_RESPONSE_BYTES) throw new Error('invalid_configuration');
  // Load only this service's static page. Invalid templates prevent startup;
  // whether the monitor or its Unix socket exists never affects the homepage.
  const indexTemplate = template === undefined ? await readIndexTemplate(indexFile, maxResponseBytes) : template;
  renderIndex(indexTemplate, maxResponseBytes);
  let eventStore;
  let collector;
  try {
    // systemd may expose its managed DynamicUser StateDirectory through this
    // fixed private-directory link. Resolve only that known service location;
    // the store still rejects symlink files and symlink replacement directories.
    if (eventDirectory === undefined) {
      const resolved = await realpath(EVENT_DIRECTORY);
      if (![EVENT_DIRECTORY, '/var/lib/private/yon-license-public-viewer'].includes(resolved)) throw new Error();
      eventDirectory = resolved;
    }
    eventStore = await createEventStore({ directory: eventDirectory });
    collector = createEventCollector({ store: eventStore, intervalMs: collectionIntervalMs,
      readStatus: async () => (await readUpstream({ socketPath, upstreamTimeoutMs, maxResponseBytes })).value });
  } catch { eventStore = undefined; }
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send = (status, body, contentType = 'text/plain; charset=utf-8') => {
      response.writeHead(status, { 'Content-Type': contentType }); response.end(body);
    };
    if (request.method !== 'GET') { response.setHeader('Allow', 'GET'); send(405, 'Read only'); return; }
    if (!['/', '/status', '/events'].includes(request.url)) { send(404, 'Not found'); return; }
    if (request.headers['transfer-encoding'] || (request.headers['content-length'] && request.headers['content-length'] !== '0')) {
      send(400, 'Request body not allowed'); return;
    }
    if (request.url === '/') {
      try {
        const page = renderIndex(indexTemplate, maxResponseBytes);
        response.setHeader('Content-Security-Policy', page.csp);
        send(200, page.body, 'text/html; charset=utf-8');
      } catch { send(503, 'Status page unavailable'); }
      return;
    }
    if (request.url === '/events') {
      try {
        if (!eventStore) throw new Error();
        const body = JSON.stringify(await eventStore.list());
        if (Buffer.byteLength(body, 'utf8') > maxResponseBytes) throw new Error();
        send(200, body, 'application/json; charset=utf-8');
      } catch { send(503, JSON.stringify({ status: 'events_unavailable' }), 'application/json; charset=utf-8'); }
      return;
    }
    const controller = new AbortController();
    const cancel = () => controller.abort();
    response.once('close', cancel);
    try {
      const upstream = await readUpstream({ socketPath, upstreamTimeoutMs, maxResponseBytes,
        signal: controller.signal });
      if (response.destroyed) return;
      response.setHeader('Content-Security-Policy', upstream.csp);
      send(200, upstream.body, upstream.contentType);
    } catch {
      if (response.destroyed) return;
      send(503, JSON.stringify({ monitor: { status: 'unavailable' },
        test: { status: 'unavailable' } }), 'application/json; charset=utf-8');
    } finally { response.removeListener('close', cancel); }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;
  server.maxRequestsPerSocket = 32;
  server.on('upgrade', (_, socket) => socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, resolve);
  });
  collector?.start();
  let closing;
  return { address: server.address(), close() {
    closing ??= (async () => {
      await Promise.all([collector?.close(), new Promise(resolve => { server.close(resolve); server.closeAllConnections(); })]);
    })();
    return closing;
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startPublicViewer().then(service => {
    const stop = () => { void service.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  }).catch(() => {
    console.error(JSON.stringify({ status: 'public_viewer_unavailable' }));
    process.exitCode = 1;
  });
}
