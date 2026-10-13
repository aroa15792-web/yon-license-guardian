import test from 'node:test';
import assert from 'node:assert/strict';
import { SUMMARY_URL, parseLicenseSummary, createLicenseSummaryClient, LicenseSummaryError } from '../src/license-summary.mjs';
import { plan } from '../src/policy.mjs';

// Synthetic fixtures exercising the observed schema; no employee or tenant data.
const body = (used = 9) => ({ status: 1, data: [{
  code: 'BIP0002YB', name: '专业应用用户数', type: 'SHAREUSER', amount: 10, usedAmount: used,
  controlPoints: [{ code: 'BIPSCM0201', labelDomain: 'MM', status: 'VALID', relyUserMaterial: 'BIP0002YB' }],
}, { code: 'FEATURE', type: 'FEATURE', amount: 0, usedAmount: 0 }] });
const response = (payload = body(), overrides = {}) => ({
  status: 200, url: SUMMARY_URL, redirected: false,
  headers: { get: () => 'application/json; charset=utf-8' },
  json: async () => payload, ...overrides,
});

test('9 remains below capacity; 10 and an overage are full; an actual zero is valid', () => {
  for (const used of [0, 9, 10, 11]) {
    const result = parseLicenseSummary(body(used));
    assert.equal(result.used, used);
    assert.equal(result.capacity, 10);
    assert.equal(result.full, used >= 10);
    assert.equal(result.source.controlPointCode, 'BIPSCM0201');
    assert.equal(result.tenantKey, undefined);
    assert.equal(result.scopeVerified, undefined);
    assert.equal(result.records, undefined);
    assert.throws(() => plan(result), /读取未成功/);
  }
});

test('error and malformed payloads cannot become zero occupancy', () => {
  for (const payload of [null, '<html>Login</html>', {}, { status: 0, data: [] }, { status: '1', data: [] },
    { status: 1, data: null }, { status: 1, data: [null] }, { status: 1, data: [] }]) {
    assert.throws(() => parseLicenseSummary(payload), LicenseSummaryError);
  }
});

test('rejects a different or ambiguous licence group and control point', () => {
  const mutations = [
    p => { p.data[0].code = 'OTHER'; },
    p => { p.data[0].type = 'USER'; },
    p => { p.data[0].name = '独立用户许可'; },
    p => { p.data.push(structuredClone(p.data[0])); },
    p => { p.data[0].controlPoints = []; },
    p => { p.data[0].controlPoints.push(structuredClone(p.data[0].controlPoints[0])); },
    p => { p.data[0].controlPoints[0].code = 'OTHER'; },
    p => { p.data[0].controlPoints[0].labelDomain = 'FIN'; },
    p => { p.data[0].controlPoints[0].status = 'EXPIRED'; },
    p => { p.data[0].controlPoints[0].relyUserMaterial = 'OTHER'; },
    p => { p.data[1].controlPoints = structuredClone(p.data[0].controlPoints); },
  ];
  for (const mutate of mutations) {
    const payload = body(); mutate(payload);
    assert.throws(() => parseLicenseSummary(payload), { code: 'wrong_target' });
  }
});

test('rejects changed capacity and invalid counts rather than coercing them', () => {
  for (const amount of [0, 9, 20, '10', null]) {
    const payload = body(); payload.data[0].amount = amount;
    assert.throws(() => parseLicenseSummary(payload), { code: 'invalid_count' });
  }
  for (const used of [-1, NaN, Infinity, 1.5, '0', null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
    const payload = body(); payload.data[0].usedAmount = used;
    assert.throws(() => parseLicenseSummary(payload), { code: 'invalid_count' });
  }
});

test('client sends only fixed GET, disables redirects and records read completion', async () => {
  let calls = 0;
  const client = createLicenseSummaryClient({
    now: () => 1_800_000_000_000,
    transport: async (url, options) => {
      calls++;
      assert.equal(url, SUMMARY_URL);
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.body, undefined);
      assert.equal(options.headers, undefined);
      assert.equal(options.signal instanceof AbortSignal, true);
      return response();
    },
  });
  assert.equal(client.release, undefined);
  const result = await client.read();
  assert.equal(calls, 1);
  assert.equal(result.observedAt, 1_800_000_000_000);
  assert.equal(result.used, 9);
});

test('rejects redirect or changed origin before reading its body', async () => {
  for (const overrides of [
    { status: 302 }, { redirected: true }, { redirected: undefined },
    { url: 'https://example.invalid/login?token=secret' },
    { url: SUMMARY_URL.replace('c3.', 'c2.') },
    { url: SUMMARY_URL.replace('MM', 'FIN') }, { type: 'opaqueredirect' },
  ]) {
    let read = false;
    const client = createLicenseSummaryClient({ transport: async () => response(body(), {
      ...overrides, json: async () => { read = true; return body(0); },
    }) });
    await assert.rejects(client.read(), { code: 'redirect' });
    assert.equal(read, false);
  }
});

test('rejects HTTP errors and HTML login pages even when HTTP status is 200', async () => {
  for (const overrides of [
    { status: 401 }, { status: 500 }, { headers: { get: () => 'text/html' } },
    { headers: { get: () => null } },
    { json: async () => { throw new Error('<html>login token=secret</html>'); } },
  ]) {
    const client = createLicenseSummaryClient({ transport: async () => response(body(0), overrides) });
    await assert.rejects(client.read(), error => {
      assert.equal(error instanceof LicenseSummaryError, true);
      assert.equal(error.message.includes('secret'), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('network errors are sanitized and never retried', async () => {
  let calls = 0;
  const client = createLicenseSummaryClient({ transport: async () => {
    calls++;
    throw new Error('Authorization: secret; Cookie: private');
  } });
  await assert.rejects(client.read(), error => error.code === 'transport_error' &&
    !/secret|Cookie|private/.test(error.message) && error.cause === undefined);
  assert.equal(calls, 1);
});

test('deadline covers both transport and response parsing, and aborts the request', async () => {
  for (const stalledPhase of ['transport', 'body']) {
    let signal;
    const client = createLicenseSummaryClient({ timeoutMs: 10, transport: async (_, options) => {
      signal = options.signal;
      if (stalledPhase === 'transport') return new Promise(() => {});
      return response(body(), { json: () => new Promise(() => {}) });
    } });
    await assert.rejects(client.read(), { code: 'timeout' });
    assert.equal(signal.aborted, true);
  }
});
