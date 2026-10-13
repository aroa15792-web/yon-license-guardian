import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { startStatusViewer } from '../status-viewer/server.mjs';
import { HOST, PORT, UPSTREAM_HOST, rewriteIndex, startPublicViewer, validateStatus } from './gateway.mjs';

const nonce = 'abcdefghijklmnopqrstuvwx';
const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`;
const template = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const html = template.replaceAll('__CSP_NONCE__', nonce);
const status = () => ({ monitor: { status: 'observing', enabled: true, checkedAt: Date.now() - 1000,
  capacity: 10, used: 2 }, test: null });

function request(port, route = '/', { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: HOST, port, method, path: route,
      headers: { Host: 'synthetic-public.invalid', Connection: 'close', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.on('error', reject); outgoing.end(body);
  });
}

async function fixture(t, { handler, missing = false, ...gatewayOptions } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yp-'));
  await chmod(directory, 0o700);
  const socketPath = path.join(directory, 'status.sock');
  let upstream;
  if (!missing) {
    upstream = http.createServer(handler || ((_, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
        'Content-Security-Policy': csp });
      response.end(JSON.stringify(status()));
    }));
    await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(socketPath, resolve); });
  }
  const gateway = await startPublicViewer({ socketPath, port: 0, ...gatewayOptions });
  t.after(async () => {
    await gateway.close();
    if (upstream) await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  return { gateway, port: gateway.address.port, socketPath };
}

test('only the exact status fetch changes and the CSP nonce remains unchanged', () => {
  const rewritten = rewriteIndex(html, csp);
  const expected = html.replace("fetch('/status', {cache:'no-store',credentials:'omit',signal:abort.signal})",
    "fetch('./status', {cache:'no-store',credentials:'same-origin',signal:abort.signal})");
  assert.equal(rewritten, expected);
  assert.equal(new URL('./status', 'https://synthetic-public.invalid/yon-license/').pathname, '/yon-license/status');
  assert.equal((rewritten.match(new RegExp(`nonce="${nonce}"`, 'g')) || []).length, 2);
  for (const source of [html.replace("fetch('/status'", "fetch('/changed'"),
    html + "fetch('/status'", html + "credentials:'omit'", html.replace('cache:\'no-store\'', "cache:'default'"),
    html.replace(`<script nonce="${nonce}">`, '<script nonce="different">')]) {
    assert.throws(() => rewriteIndex(source, csp), /upstream_unavailable/);
  }
  assert.throws(() => rewriteIndex(html, "default-src *; script-src 'unsafe-inline'"));
});

test('the independently installed static page is an unchanged copy of the private viewer', async () => {
  assert.equal(template, await readFile(new URL('../status-viewer/index.html', import.meta.url), 'utf8'));
});

test('static homepage never reads the monitor and each request gets a fresh matching nonce', async t => {
  let upstreamReads = 0;
  const f = await fixture(t, { handler(_, response) { upstreamReads++; response.end('unexpected'); } });
  const first = await request(f.port);
  const second = await request(f.port);
  const nonces = [];
  for (const page of [first, second]) {
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(page.headers['cache-control'], 'no-store');
    const actualNonce = page.headers['content-security-policy'].match(/script-src 'nonce-([^']+)'/)[1];
    nonces.push(actualNonce);
    assert.match(actualNonce, /^[A-Za-z0-9+/]{24}$/);
    assert.equal(page.body, rewriteIndex(template.replaceAll('__CSP_NONCE__', actualNonce), page.headers['content-security-policy']));
    assert.doesNotMatch(page.body, /__CSP_NONCE__|<button|<form/);
  }
  assert.notEqual(nonces[0], nonces[1]);
  assert.equal(upstreamReads, 0);
});

test('startup rejects missing, malformed, oversized or unexpectedly changed local templates', async () => {
  for (const invalidTemplate of [42, '', html, template + "fetch('/status'", template + "credentials:'omit'",
    template.replace("fetch('/status'", "fetch('/changed'"), template + '__CSP_NONCE__',
    template + ' '.repeat(65_536)]) {
    await assert.rejects(startPublicViewer({ port: 0, template: invalidTemplate }));
  }
  await assert.rejects(startPublicViewer({ port: 0, indexFile: new URL('./missing-index.html', import.meta.url) }), { code: 'ENOENT' });
  // The post-nonce, post-fetch rendered body must obey the same bound, even
  // when the unrendered source file itself fits exactly.
  await assert.rejects(startPublicViewer({ port: 0, template, maxResponseBytes: Buffer.byteLength(template, 'utf8') }), /invalid_index_template/);
});

test('a real private status viewer supplies unchanged data while homepage is independent', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yr-'));
  await chmod(directory, 0o700);
  const socketPath = path.join(directory, 'status.sock');
  const expectedStatus = status();
  let statusReads = 0;
  const upstream = await startStatusViewer({ socketPath, readStatus: async () => { statusReads++; return expectedStatus; } });
  const gateway = await startPublicViewer({ socketPath, port: 0 });
  t.after(async () => { await gateway.close(); await upstream.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(gateway.address.address, HOST);
  assert.equal(PORT, 3105);
  const page = await request(gateway.address.port);
  assert.equal(page.status, 200);
  assert.match(page.body, /fetch\('\.\/status'/);
  assert.match(page.body, /credentials:'same-origin'/);
  assert.doesNotMatch(page.body, /fetch\('\/status'|credentials:'omit'|<button|<form/);
  const actualNonce = page.headers['content-security-policy'].match(/script-src 'nonce-([^']+)'/)[1];
  assert.equal((page.body.match(new RegExp(`nonce="${actualNonce.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'g')) || []).length, 2);
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(statusReads, 0);
  const summary = await request(gateway.address.port, '/status');
  assert.equal(summary.status, 200);
  assert.deepEqual(JSON.parse(summary.body), expectedStatus);
  assert.equal(statusReads, 1);
});

test('fixed upstream host and headers do not forward client secrets or upstream cookies', async t => {
  const received = [];
  const f = await fixture(t, { handler(incoming, response) {
    received.push({ method: incoming.method, url: incoming.url, headers: incoming.headers });
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Security-Policy': csp,
      'Set-Cookie': 'synthetic-private-cookie=value', 'X-Private-Field': 'synthetic-private-header',
      'Cache-Control': 'public, max-age=999' });
    response.end(JSON.stringify(status()));
  } });
  const result = await request(f.port, '/status', { headers: {
    Authorization: 'Basic synthetic-private-auth', Cookie: 'synthetic-private-cookie=value',
    Origin: 'https://synthetic-untrusted.invalid', 'X-Forwarded-For': 'synthetic-private-address',
    'X-Forwarded-Host': 'synthetic-forwarded.invalid', 'X-Forwarded-Proto': 'https',
  } });
  assert.equal(result.status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'GET');
  assert.equal(received[0].url, '/status');
  assert.deepEqual(received[0].headers, { host: UPSTREAM_HOST, connection: 'close',
    'accept-encoding': 'identity', accept: 'application/json' });
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(result.headers['x-private-field'], undefined);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.headers['content-security-policy'], csp);
  assert.doesNotMatch(result.body, /synthetic-private/);
});

test('methods, alternate paths, query parameters, GET bodies and WebSocket never contact upstream', async t => {
  let reads = 0;
  const f = await fixture(t, { handler(_, response) { reads++; response.end('unexpected'); } });
  for (const method of ['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE']) {
    const result = await request(f.port, '/status', { method });
    assert.equal(result.status, 405, method);
    assert.equal(result.headers.allow, 'GET');
  }
  for (const route of ['/release', '/snapshot', '/index.html', '/status?x=1', '/?x=1',
    '/yon-license/', '/status/', '//status', '/../status', '/%2e%2e/status', '/status%00']) {
    assert.equal((await request(f.port, route)).status, 404, route);
  }
  assert.equal((await request(f.port, '/status', { headers: { 'Content-Length': '1' }, body: 'x' })).status, 400);
  assert.equal((await request(f.port, '/status', { headers: { 'Transfer-Encoding': 'chunked' }, body: 'x' })).status, 400);
  assert.equal((await request(f.port, '/status', { headers: { Connection: 'Upgrade', Upgrade: 'websocket' } })).status, 404);
  assert.equal(reads, 0);
});

test('missing upstream leaves the homepage available and the status explicitly unavailable', async t => {
  const f = await fixture(t, { missing: true });
  const page = await request(f.port);
  assert.equal(page.status, 200);
  assert.match(page.body, /fetch\('\.\/status'/);
  assert.match(page.body, /if \(!response.ok\) throw new Error\(\)/);
  assert.match(page.body, /element\('used'\)\.textContent = '— \/ 10'/);
  assert.match(page.body, /状态页连接中断/);
  const result = await request(f.port, '/status');
  assert.equal(result.status, 503);
  assert.deepEqual(JSON.parse(result.body), { monitor: { status: 'unavailable' }, test: { status: 'unavailable' } });
  assert.doesNotMatch(result.body, /used|capacity|synthetic-private|status\.sock/);
});

test('upstream errors, redirects, invalid CSP, unexpected content and private JSON fields fail closed', async t => {
  const scenarios = [
    { statusCode: 500 }, { statusCode: 302, extra: { Location: 'https://synthetic-private.invalid' } },
    { extra: { 'Content-Security-Policy': "default-src *" } },
    { extra: { 'Content-Type': 'text/plain' } },
    { extra: { 'Content-Encoding': 'gzip' } },
    { body: '{"monitor":{"status":"observing","used":0},"test":null}' },
    { body: JSON.stringify({ ...status(), records: [{ id: 'synthetic-private-person' }] }) },
    { body: JSON.stringify({ ...status(), monitor: { ...status().monitor, cookie: 'synthetic-private-cookie' } }) },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    await t.test(`scenario ${index + 1}`, async child => {
      const f = await fixture(child, { handler(_, response) {
        response.writeHead(scenario.statusCode || 200, { 'Content-Type': 'application/json; charset=utf-8',
          'Content-Security-Policy': csp, ...scenario.extra });
        response.end(scenario.body || 'synthetic-private-upstream-error');
      } });
      const result = await request(f.port, '/status');
      assert.equal(result.status, 503);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-private|Location|cookie|records|used/);
    });
  }
});

test('known response length and a chunked response both obey the size limit', async t => {
  const maxResponseBytes = Buffer.byteLength(template, 'utf8') + 1024;
  for (const contentLength of [true, false]) {
    await t.test(contentLength ? 'content length' : 'chunked', async child => {
      const f = await fixture(child, { maxResponseBytes, handler(_, response) {
        response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8',
          'Content-Security-Policy': csp, ...(contentLength ? { 'Content-Length': String(maxResponseBytes + 1) } : {}) });
        response.end('x'.repeat(maxResponseBytes + 1));
      } });
      const result = await request(f.port, '/status');
      assert.equal(result.status, 503);
      assert.doesNotMatch(result.body, /xx|used/);
    });
  }
});

test('a fixed deadline bounds a hanging or slowly streaming upstream', async t => {
  for (const trickle of [false, true]) {
    await t.test(trickle ? 'trickle' : 'no headers', async child => {
      let interval;
      child.after(() => clearInterval(interval));
      const f = await fixture(child, { upstreamTimeoutMs: 50, handler(_, response) {
        if (trickle) {
          response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Security-Policy': csp });
          response.write('{');
          interval = setInterval(() => response.write(' '), 10);
        }
      } });
      const started = performance.now();
      const result = await request(f.port, '/status');
      assert.equal(result.status, 503);
      assert.ok(performance.now() - started < 2000);
    });
  }
});

test('status contract preserves allowed states and rejects unexpected or inconsistent fields', () => {
  const now = Date.now();
  const basic = { enabled: true, checkedAt: now };
  for (const state of ['checking', 'cooldown', 'changed_retry_next_cycle', 'paused', 'stopped']) {
    assert.equal(validateStatus({ monitor: { status: state, ...basic }, test: null }, now), true);
  }
  const released = { status: 'released', ...basic, capacity: 10, before: 10, after: 0, released: 10 };
  const verified = { status: 'verified', checkedAt: now, before: 8, after: 0, released: 8 };
  assert.equal(validateStatus({ monitor: released, test: verified }, now), true);
  assert.equal(validateStatus({ monitor: { status: 'unavailable' }, test: { status: 'unavailable' } }, now), true);
  assert.equal(validateStatus({ monitor: { status: 'preview', ...basic, enabled: false, capacity: 10, used: 10 },
    test: { status: 'pending', checkedAt: now, before: 8 } }, now), true);
  for (const invalid of [
    { ...released, after: 10 }, { ...released, released: 11 }, { ...released, capacity: 7 },
    { ...released, checkedAt: now + 1 }, { ...released, status: 'synthetic-private' },
    { ...released, records: [{ id: 'synthetic-private-person' }] },
  ]) assert.equal(validateStatus({ monitor: invalid, test: null }, now), false);
  assert.equal(validateStatus({ monitor: released, test: { ...verified, cookie: 'synthetic-private' } }, now), false);
  assert.equal(validateStatus({ monitor: released, test: { ...verified, after: 8 } }, now), false);
});
