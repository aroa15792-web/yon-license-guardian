import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, chmod, rm, lstat, writeFile, readFile } from 'node:fs/promises';
import { createStatusReader, sanitizeMonitor, sanitizeTest, startStatusViewer, MONITOR_PATH, TEST_PATH } from './server.mjs';

const now = 1_800_000_000_000;
const privateFields = { operationId: 'synthetic-private-operation', fingerprint: 'synthetic-private-hash',
  tenantKey: 'synthetic-private-tenant', company: 'synthetic-private-company', cookie: 'synthetic-private-cookie',
  records: [{ id: 'synthetic-private-person' }] };
const monitor = { status: 'observing', enabled: true, checkedAt: now, used: 0, capacity: 10, ...privateFields };
const manual = { status: 'verified', at: now - 30_000, before: 8, after: 0, released: 8, ...privateFields };

function reader(values = { [MONITOR_PATH]: monitor, [TEST_PATH]: manual }) {
  const paths = [];
  return { paths, readStatus: createStatusReader({ now: () => now, readJson: async file => {
    paths.push(file);
    const value = values[file];
    if (value instanceof Error) throw value;
    return value;
  } }) };
}

test('only fixed files are read and only whitelisted scalar state/counts are returned', async () => {
  const source = reader();
  const result = await source.readStatus();
  assert.deepEqual(source.paths, [MONITOR_PATH, TEST_PATH]);
  assert.deepEqual(result, {
    monitor: { status: 'observing', enabled: true, checkedAt: now, capacity: 10, used: 0 },
    test: { status: 'verified', checkedAt: now - 30_000, before: 8, after: 0, released: 8 },
  });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-private|operationId|fingerprint|tenantKey|company|cookie|records/);
  const changed = await reader({ [MONITOR_PATH]: { ...monitor, used: 3 },
    [TEST_PATH]: { ...manual, before: 5, after: 1, released: 5 } }).readStatus();
  assert.equal(changed.monitor.used, 3);
  assert.equal(changed.test.before, 5);
  assert.equal(changed.test.after, 1);
});

test('invalid or failed reads never turn into zero and pending tests remain unconfirmed', async () => {
  for (const value of [null, { ...monitor, used: '0' }, { ...monitor, used: -1 },
    { ...monitor, capacity: 7 }, { ...monitor, checkedAt: now + 1 }, { ...monitor, status: 'synthetic-private' }]) {
    assert.deepEqual(sanitizeMonitor(value, now), { status: 'unavailable' });
  }
  assert.deepEqual(sanitizeTest({ ...manual, after: 8 }, now), { status: 'unavailable' });
  assert.deepEqual(sanitizeTest({ ...manual, status: 'pending' }, now), {
    status: 'pending', checkedAt: now - 30_000, before: 8,
  });
  const source = reader({ [MONITOR_PATH]: new Error('synthetic-private-error'),
    [TEST_PATH]: Object.assign(new Error('synthetic-private-path'), { code: 'ENOENT' }) });
  assert.deepEqual(await source.readStatus(), { monitor: { status: 'unavailable' }, test: null });
  const damaged = reader({ [MONITOR_PATH]: monitor, [TEST_PATH]: new SyntaxError('synthetic-private-json') });
  assert.deepEqual((await damaged.readStatus()).test, { status: 'unavailable' });
});

function request(socketPath, route = '/', { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: route, method,
      headers: { Host: '127.0.0.1:19080', Connection: 'close', ...headers } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    request.on('error', reject); request.end();
  });
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ys-'));
  await chmod(directory, 0o700);
  const socketPath = path.join(directory, 's.sock');
  const source = reader();
  const service = await startStatusViewer({ socketPath, readStatus: source.readStatus });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, socketPath, service, source };
}

test('Unix status service serves nonce-protected no-cache UI and live sanitized status', async t => {
  const f = await fixture(t);
  assert.equal((await lstat(f.socketPath)).isSocket(), true);
  assert.equal((await lstat(f.socketPath)).mode & 0o777, 0o600);
  const page = await request(f.socketPath);
  assert.equal(page.status, 200);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  const nonce = page.headers['content-security-policy'].match(/script-src 'nonce-([^']+)'/)[1];
  assert.match(page.body, new RegExp(`nonce="${nonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.doesNotMatch(page.body, /__CSP_NONCE__|<button|8 → 0/);
  assert.match(page.body, /服务器独立运行/);
  assert.match(page.body, /15_000/);
  const status = await request(f.socketPath, '/status');
  assert.equal(status.status, 200);
  assert.equal(status.headers['cache-control'], 'no-store');
  assert.match(status.headers['content-type'], /^application\/json/);
  assert.equal(JSON.parse(status.body).test.before, 8);
  assert.doesNotMatch(status.body, /synthetic-private|operationId|fingerprint|tenantKey|company|cookie|records/);
  assert.equal((await request(f.socketPath, '/status', { headers: { Host: 'localhost:19080' } })).status, 200);
});

test('mutations, alternate paths, traversal and untrusted hosts/origins never read status', async t => {
  const f = await fixture(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    assert.equal((await request(f.socketPath, '/status', { method })).status, 405);
  }
  for (const route of ['/release', '/index.html', '/status?path=/etc/passwd', '/?x=1',
    '/../status', '/%2e%2e/status', '/status/', '//status', '/status%00', '/etc/passwd']) {
    assert.equal((await request(f.socketPath, route)).status, 404, route);
  }
  assert.equal((await request(f.socketPath, '/status', { headers: { Host: 'untrusted.invalid' } })).status, 403);
  assert.equal((await request(f.socketPath, '/status', { headers: { Origin: 'https://untrusted.invalid' } })).status, 403);
  assert.equal(f.source.paths.length, 0);
});

test('start refuses unsafe directories or existing paths and close removes only its owned socket', async t => {
  const f = await fixture(t);
  await assert.rejects(startStatusViewer({ socketPath: f.socketPath }));
  await f.service.close();
  await assert.rejects(lstat(f.socketPath), { code: 'ENOENT' });
  await writeFile(f.socketPath, 'existing unrelated file', { mode: 0o600 });
  await assert.rejects(startStatusViewer({ socketPath: f.socketPath }));
  assert.equal(await readFile(f.socketPath, 'utf8'), 'existing unrelated file');
  await chmod(f.directory, 0o755);
  await assert.rejects(startStatusViewer({ socketPath: path.join(f.directory, 'other.sock') }));
});
