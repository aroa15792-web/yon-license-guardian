import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { readFile, readdir, realpath, stat, chmod } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const require = createRequire(import.meta.url);
const ownDirectory = path.dirname(fileURLToPath(import.meta.url));
const allowedHosts = new Set(['127.0.0.1:19080', 'localhost:19080', '[::1]:19080']);
const maximumBufferedBytes = 4 * 1024 * 1024;

// Reject before URL parsing, which would otherwise normalize traversal away.
export function resolveStaticRoute(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048 || !rawUrl.startsWith('/')) return null;
  const rawPath = rawUrl.split('?', 1)[0];
  let decoded;
  try { decoded = decodeURIComponent(rawPath); } catch { return null; }
  if (/[\\\0%]/.test(decoded) || decoded.split('/').some(part => part === '.' || part === '..')) return null;
  if (decoded === '/' || decoded === '/index.html') return { kind: 'index' };
  if (!/^\/novnc\/(?:core|vendor)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.js$/.test(decoded)) return null;
  return { kind: 'module', relativePath: decoded.slice('/novnc/'.length) };
}

function validHost(request) {
  return allowedHosts.has(request.headers.host);
}

function validOrigin(request) {
  return validHost(request) && request.headers.origin === `http://${request.headers.host}`;
}

function jsonForHtml(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, character =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

async function moduleAllowlist(root) {
  const result = new Map();
  const canonicalRoot = await realpath(root);
  async function walk(relativeDirectory) {
    for (const entry of await readdir(path.join(canonicalRoot, relativeDirectory), { withFileTypes: true })) {
      const relativeName = `${relativeDirectory}/${entry.name}`;
      if (entry.isDirectory()) await walk(relativeName);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        const route = resolveStaticRoute(`/novnc/${relativeName}`);
        if (!route) continue;
        const actualPath = await realpath(path.join(canonicalRoot, relativeName));
        if (actualPath.startsWith(`${canonicalRoot}${path.sep}`)) result.set(relativeName, actualPath);
      }
    }
  }
  await walk('core');
  await walk('vendor');
  return result;
}

function rejectUpgrade(socket, status, reason) {
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export async function startVisualLoginServer({
  socketPath,
  passwordFile,
  novncRoot = path.dirname(path.dirname(require.resolve('@novnc/novnc'))),
  indexFile = path.join(ownDirectory, 'index.html'),
}) {
  if (!path.isAbsolute(socketPath ?? '') || !path.isAbsolute(passwordFile ?? '')) {
    throw new Error('Private socket and password file paths are required');
  }
  const runtimeDirectory = await stat(path.dirname(socketPath));
  if (!runtimeDirectory.isDirectory() || (runtimeDirectory.mode & 0o777) !== 0o700 ||
      runtimeDirectory.uid !== process.getuid()) throw new Error('Private runtime directory required');
  const passwordMetadata = await stat(passwordFile);
  if (!passwordMetadata.isFile() || (passwordMetadata.mode & 0o077) !== 0 ||
      passwordMetadata.uid !== process.getuid()) throw new Error('Private password file required');
  const passwordText = await readFile(passwordFile, 'utf8');
  if (!/^[\x21-\x7e]{8}(?:\r?\n)?$/.test(passwordText)) throw new Error('An eight-character VNC password is required');
  const password = passwordText.replace(/\r?\n$/, '');
  const template = await readFile(indexFile, 'utf8');
  if (!template.includes('__VNC_CONFIG_JSON__') || !template.includes('__CSP_NONCE__')) {
    throw new Error('Invalid visual login template');
  }
  const modules = await moduleAllowlist(novncRoot);
  const websocketServer = new WebSocketServer({
    noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024,
  });
  const activeConnections = new Set();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    try {
      if (!validHost(request) || (request.headers.origin && !validOrigin(request))) {
        response.writeHead(403); response.end('Forbidden'); return;
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
      }
      const route = resolveStaticRoute(request.url);
      if (!route) { response.writeHead(404); response.end('Not found'); return; }
      let content;
      if (route.kind === 'index') {
        const nonce = randomBytes(18).toString('base64');
        response.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        content = Buffer.from(template.replaceAll('__CSP_NONCE__', nonce)
          .replace('__VNC_CONFIG_JSON__', jsonForHtml({ password })));
      } else {
        const modulePath = modules.get(route.relativePath);
        if (!modulePath) { response.writeHead(404); response.end('Not found'); return; }
        response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        content = await readFile(modulePath);
      }
      response.setHeader('Content-Length', content.length);
      response.writeHead(200);
      response.end(request.method === 'HEAD' ? undefined : content);
    } catch {
      if (!response.headersSent) response.writeHead(500);
      response.end('Request unavailable');
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;

  server.on('upgrade', (request, socket, head) => {
    if (request.url !== '/vnc') { rejectUpgrade(socket, 404, 'Not Found'); return; }
    if (request.method !== 'GET' || !validOrigin(request)) { rejectUpgrade(socket, 403, 'Forbidden'); return; }
    if (activeConnections.size > 0) { rejectUpgrade(socket, 409, 'Conflict'); return; }
    websocketServer.handleUpgrade(request, socket, head, websocket => {
      activeConnections.add(websocket);
      // The destination cannot be supplied by the request or environment.
      const backend = net.connect({ host: '127.0.0.1', port: 19590 });
      const connectDeadline = setTimeout(() => {
        backend.destroy(); websocket.close(1011, 'Desktop unavailable');
      }, 5_000);
      backend.once('connect', () => clearTimeout(connectDeadline));
      backend.on('data', chunk => {
        if (websocket.readyState !== WebSocket.OPEN || websocket.bufferedAmount > maximumBufferedBytes) {
          backend.destroy(); websocket.terminate(); return;
        }
        websocket.send(chunk, { binary: true }, error => {
          if (error) backend.destroy();
        });
      });
      backend.on('drain', () => websocket.resume());
      backend.on('error', () => websocket.close(1011, 'Desktop unavailable'));
      backend.on('close', () => { clearTimeout(connectDeadline); websocket.close(1000, 'Desktop disconnected'); });
      websocket.on('message', (data, binary) => {
        if (!binary) { websocket.close(1003, 'Binary protocol required'); backend.destroy(); return; }
        if (!backend.write(data)) websocket.pause();
      });
      websocket.on('error', () => backend.destroy());
      websocket.on('close', () => {
        activeConnections.delete(websocket); clearTimeout(connectDeadline); backend.destroy();
      });
    });
  });
  server.on('clientError', (_, socket) => rejectUpgrade(socket, 400, 'Bad Request'));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { server.off('error', reject); resolve(); });
  });
  await chmod(socketPath, 0o600);
  return {
    server,
    async close() {
      for (const websocket of activeConnections) websocket.terminate();
      await new Promise(resolve => websocketServer.close(resolve));
      await new Promise(resolve => server.close(resolve));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const service = await startVisualLoginServer({
      socketPath: process.env.YON_VNC_SOCKET_PATH,
      passwordFile: process.env.YON_VNC_PASSWORD_FILE,
    });
    console.log('Visual login ready on private Unix socket');
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      await service.close();
      process.exit(0);
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  } catch {
    console.error('Visual login startup failed; verify private runtime paths and dependencies');
    process.exitCode = 1;
  }
}
