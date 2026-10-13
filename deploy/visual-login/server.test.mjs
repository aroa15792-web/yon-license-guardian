import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { resolveStaticRoute, startVisualLoginServer } from './server.mjs';

test('static routes reject traversal, encoded escapes, non-module files and other roots', () => {
  for (const route of [
    '/novnc/core/../../server.mjs', '/novnc/core/%2e%2e/vendor/x.js',
    '/novnc/core/%252e%252e/x.js', '/novnc/core/..%2fx.js',
    '/novnc/core/x%00.js', '/novnc/core/..\\x.js', '/novnc/package.json',
    '/novnc/core/package.json', '/node_modules/ws/index.js', '/etc/passwd', '//index.html', '/novnc/core/%zz.js',
  ]) assert.equal(resolveStaticRoute(route), null, route);
  assert.deepEqual(resolveStaticRoute('/novnc/core/rfb.js'), { kind: 'module', relativePath: 'core/rfb.js' });
  assert.deepEqual(resolveStaticRoute('/novnc/vendor/pako/lib/inflate.js'), { kind: 'module', relativePath: 'vendor/pako/lib/inflate.js' });
});

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yv-'));
  await chmod(directory, 0o700);
  const passwordFile = path.join(directory, 'secret');
  await writeFile(passwordFile, 'Te<st&42\n', { mode: 0o600 });
  const socketPath = path.join(directory, 'web.sock');
  const service = await startVisualLoginServer({ socketPath, passwordFile });
  return { socketPath, close: async () => { await service.close(); await rm(directory, { recursive: true, force: true }); } };
}

function request(socketPath, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: route, headers: { Host: '127.0.0.1:19080', ...headers } }, response => {
      let content = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { content += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, content }));
    });
    request.on('upgrade', (_, socket) => { socket.destroy(); reject(new Error('Unexpected websocket upgrade')); });
    request.on('error', reject);
    request.end();
  });
}

test('Unix-only server returns private no-cache UI and real noVNC modules, not traversal or unrelated files', async () => {
  const fixtureData = await fixture();
  try {
    assert.equal((await stat(fixtureData.socketPath)).mode & 0o777, 0o600);
    const ui = await request(fixtureData.socketPath, '/');
    assert.equal(ui.status, 200);
    assert.equal(ui.headers['cache-control'], 'no-store');
    assert.match(ui.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.ok(!ui.content.includes('Te<st&42'));
    assert.ok(ui.content.includes('Te\\u003cst\\u002642'));
    assert.equal((await request(fixtureData.socketPath, '/novnc/core/rfb.js')).status, 200);
    for (const route of ['/novnc/core/%2e%2e/package.json', '/novnc/package.json', '/server.mjs', '/novnc/core/missing.js']) {
      assert.equal((await request(fixtureData.socketPath, route)).status, 404);
    }
    assert.equal((await request(fixtureData.socketPath, '/', { Host: 'untrusted.invalid' })).status, 403);
  } finally { await fixtureData.close(); }
});

test('WebSocket handshake rejects every route except exact /vnc and requires same local origin', async () => {
  const fixtureData = await fixture();
  const headers = {
    Connection: 'Upgrade', Upgrade: 'websocket',
    'Sec-WebSocket-Key': Buffer.alloc(16).toString('base64'), 'Sec-WebSocket-Version': '13',
    Origin: 'http://127.0.0.1:19080',
  };
  try {
    for (const route of ['/other', '/vnc?target=example.invalid', '/%76nc', '/vnc/']) {
      assert.equal((await request(fixtureData.socketPath, route, headers)).status, 404);
    }
    assert.equal((await request(fixtureData.socketPath, '/vnc', { ...headers, Origin: 'https://untrusted.invalid' })).status, 403);
    const noOrigin = { ...headers }; delete noOrigin.Origin;
    assert.equal((await request(fixtureData.socketPath, '/vnc', noOrigin)).status, 403);
  } finally { await fixtureData.close(); }
});
