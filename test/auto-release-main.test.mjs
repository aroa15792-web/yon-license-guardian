import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { callLicenseRpc, createLiveAdapter } from '../src/auto-release-main.mjs';
import { Controller } from '../src/controller.mjs';
import { TARGET, fingerprint } from '../src/policy.mjs';
import { SOCKET_PATH } from '../src/summary-monitor.mjs';

const now = 1_800_000_000_000;
const snapshot = () => ({
  ...TARGET, status: 'ok', tenantKey: 'synthetic-tenant', scopeVerified: true,
  unfiltered: true, complete: true, observedAt: now, licenseState: 'active', used: 10,
  records: Array.from({ length: 10 }, (_, index) => ({ id: `synthetic-person-${index}` })),
});
const operationFor = value => ({
  ids: value.records.map(record => record.id), expectedFingerprint: fingerprint(value),
  tenantKey: value.tenantKey, operationId: randomUUID(),
});

test('adapter re-reads a complete snapshot a third time before the single release RPC', async () => {
  const calls = [];
  const original = snapshot();
  const operation = operationFor(original);
  const adapter = createLiveAdapter({ now: () => now, rpc: async (route, value) => {
    calls.push({ route, value });
    return route === '/snapshot' ? { status: 'ok', snapshot: structuredClone(original) } : { status: 'acknowledged' };
  } });
  await adapter.read();
  await adapter.read();
  assert.deepEqual(await adapter.release(operation), { status: 'acknowledged' });
  assert.deepEqual(calls.map(call => call.route), ['/snapshot', '/snapshot', '/snapshot', '/release']);
  assert.equal(calls.at(-1).value, operation);
});

test('fingerprint, enterprise, selection and third-read membership changes prevent POST', async () => {
  for (const change of ['fingerprint', 'tenant', 'ids', 'third_membership', 'third_incomplete']) {
    const original = snapshot();
    const operation = operationFor(original);
    const calls = [];
    const third = structuredClone(original);
    if (change === 'fingerprint') operation.expectedFingerprint = 'f'.repeat(64);
    if (change === 'tenant') operation.tenantKey = 'another-synthetic-tenant';
    if (change === 'ids') operation.ids[0] = 'another-synthetic-person';
    if (change === 'third_membership') third.records[0].id = 'new-synthetic-person';
    if (change === 'third_incomplete') third.complete = false;
    const adapter = createLiveAdapter({ now: () => now, rpc: async route => {
      calls.push(route);
      assert.equal(route, '/snapshot', 'changed scope must never send a release');
      return { status: 'ok', snapshot: structuredClone(calls.length === 3 ? third : original) };
    } });
    await adapter.read(); await adapter.read();
    if (change === 'third_incomplete') await assert.rejects(adapter.release(operation));
    else await assert.rejects(adapter.release(operation), { code: 'snapshot_changed' });
    assert.deepEqual(calls, ['/snapshot', '/snapshot', '/snapshot']);
  }
});

test('selection order alone does not become a false scope mismatch', async () => {
  const original = snapshot();
  const operation = operationFor(original);
  operation.ids.reverse();
  const reordered = structuredClone(original);
  reordered.records.reverse();
  const calls = [];
  const adapter = createLiveAdapter({ now: () => now, rpc: async route => {
    calls.push(route);
    return route === '/snapshot' ? { status: 'ok', snapshot: reordered } : { status: 'acknowledged' };
  } });
  assert.deepEqual(await adapter.release(operation), { status: 'acknowledged' });
  assert.deepEqual(calls, ['/snapshot', '/release']);
});

test('failed preflight or release RPC is never retried, and non-acknowledgement stays ambiguous', async () => {
  for (const phase of ['preflight', 'release', 'unacknowledged']) {
    const original = snapshot();
    const calls = [];
    const failure = Object.assign(new Error('synthetic RPC failure'), { code: 'transport_error' });
    const adapter = createLiveAdapter({ now: () => now, rpc: async route => {
      calls.push(route);
      if (route === '/snapshot') {
        if (phase === 'preflight') throw failure;
        return { status: 'ok', snapshot: original };
      }
      if (phase === 'release') throw failure;
      return { status: 'ok' };
    } });
    await assert.rejects(adapter.release(operationFor(original)), {
      code: phase === 'unacknowledged' ? 'reconciliation_required' : 'transport_error',
    });
    assert.deepEqual(calls, phase === 'preflight' ? ['/snapshot'] : ['/snapshot', '/release']);
  }
});

test('acknowledged release tolerates delayed snapshots until count drops and every old ID is gone', async () => {
  let clock = now;
  const delays = [];
  const calls = [];
  const original = snapshot();
  const operation = operationFor(original);
  const partial = { ...original, used: 1, records: [original.records[0]] };
  const confirmed = { ...original, used: 1, records: [{ id: 'new-synthetic-person' }] };
  const responses = [original, Object.assign(new Error('changing'), { code: 'snapshot_changed' }),
    original, partial, confirmed];
  const adapter = createLiveAdapter({
    now: () => clock,
    sleep: async milliseconds => { delays.push(milliseconds); clock += milliseconds; },
    rpc: async route => {
      calls.push(route);
      if (route === '/release') return { status: 'acknowledged' };
      const value = responses.shift();
      if (value instanceof Error) throw value;
      return { status: 'ok', snapshot: { ...value, observedAt: clock } };
    },
  });
  await adapter.release(operation);
  // The expected selection belongs to the acknowledged operation, not the
  // caller's mutable array after acknowledgement.
  operation.ids.fill('mutated-synthetic-person');
  const result = await adapter.read();
  assert.equal(result.used, 1);
  assert.deepEqual(result.records, confirmed.records);
  assert.deepEqual(delays, [1_000, 2_000, 4_000]);
  assert.equal(calls.filter(route => route === '/release').length, 1);
  assert.equal(calls.filter(route => route === '/snapshot').length, 5);
});

test('five stale post-release counts leave Controller pending and cannot repeat the POST', async () => {
  let clock = now;
  const delays = [];
  const calls = [];
  let released = false;
  let stored = null;
  const original = snapshot();
  // Even when all selected IDs disappeared, an unchanged count is not proof
  // that capacity was freed and must not become a second release operation.
  const stale = { ...original, records: original.records.map((_, index) => ({ id: `new-synthetic-${index}` })) };
  const adapter = createLiveAdapter({
    now: () => clock,
    sleep: async milliseconds => { delays.push(milliseconds); clock += milliseconds; },
    rpc: async route => {
      calls.push(route);
      if (route === '/release') { released = true; return { status: 'acknowledged' }; }
      return { status: 'ok', snapshot: { ...(released ? stale : original), observedAt: clock } };
    },
  });
  const controller = new Controller({ adapter, enabled: true, now: () => clock,
    journal: { read: async () => stored, write: async value => { stored = structuredClone(value); } },
  });
  assert.equal((await controller.tick()).status, 'needs_reconciliation');
  assert.equal(stored.status, 'pending');
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000]);
  assert.equal(calls.filter(route => route === '/snapshot').length, 8, 'three preflight plus five verification reads');
  assert.equal(calls.filter(route => route === '/release').length, 1);
  const count = calls.length;
  assert.equal((await controller.tick()).status, 'needs_reconciliation');
  await assert.rejects(adapter.read(), { code: 'reconciliation_required' });
  await assert.rejects(adapter.release(operationFor(original)), { code: 'reconciliation_required' });
  assert.equal(calls.length, count, 'unresolved outcome must not cause more reads or writes');
});

test('verification stops at its total 30 second deadline even before five attempts', async () => {
  let clock = now;
  let released = false;
  const delays = [];
  const calls = [];
  const original = snapshot();
  const adapter = createLiveAdapter({
    now: () => clock,
    sleep: async milliseconds => { delays.push(milliseconds); clock += milliseconds; },
    rpc: async route => {
      calls.push(route);
      if (route === '/release') { released = true; return { status: 'acknowledged' }; }
      if (released) clock += 12_000;
      return { status: 'ok', snapshot: { ...original, observedAt: clock } };
    },
  });
  await adapter.release(operationFor(original));
  await assert.rejects(adapter.read(), { code: 'reconciliation_required' });
  assert.deepEqual(delays, [1_000, 2_000]);
  assert.equal(calls.filter(route => route === '/snapshot').length, 4);
  assert.equal(calls.filter(route => route === '/release').length, 1);
});

test('30 second wall-clock deadline rejects a stalled verification and ignores its late response', async t => {
  const original = snapshot();
  const calls = [];
  let released = false;
  let finishRead;
  let expire;
  let cleared = false;
  const timer = {};
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { assert.equal(delay, 30_000); expire = callback; return timer; });
  t.mock.method(globalThis, 'clearTimeout', value => { assert.equal(value, timer); cleared = true; });
  const adapter = createLiveAdapter({ now: () => now,
    sleep: async () => { assert.fail('must not retry after deadline'); },
    rpc: async route => {
      calls.push(route);
      if (route === '/release') { released = true; return { status: 'acknowledged' }; }
      if (released) return new Promise(resolve => { finishRead = resolve; });
      return { status: 'ok', snapshot: original };
    },
  });
  await adapter.release(operationFor(original));
  const reading = adapter.read();
  expire();
  await assert.rejects(reading, { code: 'reconciliation_required' });
  assert.equal(cleared, true);
  finishRead({ status: 'ok', snapshot: { ...original, used: 0, records: [] } });
  await assert.rejects(adapter.read(), { code: 'reconciliation_required' });
  await assert.rejects(adapter.release(operationFor(original)), { code: 'reconciliation_required' });
  assert.deepEqual(calls, ['/snapshot', '/release', '/snapshot']);
});

test('post-release 401 and all non-snapshot-change failures stop immediately without read or write retry', async () => {
  for (const failure of ['401', '403', 'transport_error', 'wrong_target', 'wrong_tenant', 'invalid_snapshot']) {
    const original = snapshot();
    const calls = [];
    let released = false;
    const transport = fakeTransport({ statusCode: failure === '401' ? 401 : 403,
      value: { status: failure === '401' ? 'needs_login' : 'access_denied' } });
    const adapter = createLiveAdapter({ now: () => now,
      sleep: async () => { assert.fail(`${failure} must not retry`); },
      rpc: async route => {
        calls.push(route);
        if (route === '/release') { released = true; return { status: 'acknowledged' }; }
        if (!released) return { status: 'ok', snapshot: original };
        if (['401', '403'].includes(failure)) return callLicenseRpc('/snapshot', undefined, { request: transport.request });
        if (failure === 'wrong_tenant') return { status: 'ok', snapshot: { ...original, tenantKey: 'another-tenant' } };
        if (failure === 'invalid_snapshot') return { status: 'ok', snapshot: { ...original, used: 0 } };
        throw Object.assign(new Error('synthetic failure'), { code: failure });
      },
    });
    await adapter.release(operationFor(original));
    const code = failure === '401' ? 'needs_login' : failure === '403' ? 'access_denied' : failure;
    if (failure === 'invalid_snapshot') await assert.rejects(adapter.read());
    else await assert.rejects(adapter.read(), { code });
    assert.deepEqual(calls, ['/snapshot', '/release', '/snapshot']);
    if (['401', '403'].includes(failure)) assert.equal(transport.calls.length, 1);
  }
});

function fakeTransport({
  value = { status: 'ok', snapshot: snapshot() }, body = JSON.stringify(value),
  statusCode = 200, contentType = 'application/json; charset=utf-8', requestFailure = false,
  responseFailure = false, hang = false,
} = {}) {
  const calls = [];
  let requestObject;
  let responseObject;
  let callbackError;
  const request = (options, callback) => {
    const call = { options };
    calls.push(call);
    requestObject = new EventEmitter();
    requestObject.destroy = () => { requestObject.destroyed = true; };
    requestObject.end = data => {
      call.body = data;
      queueMicrotask(() => {
        if (hang) return;
        if (requestFailure) { requestObject.emit('error', new Error('Cookie: synthetic-secret')); return; }
        responseObject = new EventEmitter();
        responseObject.statusCode = statusCode;
        responseObject.headers = contentType === undefined ? {} : { 'content-type': contentType };
        responseObject.destroy = () => { responseObject.destroyed = true; };
        try {
          callback(responseObject);
          if (responseFailure) { responseObject.emit('aborted'); return; }
          responseObject.emit('data', Buffer.from(body));
          responseObject.emit('end');
        } catch (error) {
          // Convert an escaping callback exception into a testable rejection;
          // callers additionally assert no exception escaped the RPC handler.
          callbackError = error;
          requestObject.emit('error', error);
        }
      });
    };
    return requestObject;
  };
  return { request, calls, requestObject: () => requestObject, responseObject: () => responseObject,
    callbackError: () => callbackError };
}

test('RPC uses only the fixed Unix socket with GET /snapshot or JSON POST /release', async () => {
  const reading = fakeTransport();
  await callLicenseRpc('/snapshot', undefined, { request: reading.request });
  assert.deepEqual(reading.calls[0], { options: {
    socketPath: SOCKET_PATH, path: '/snapshot', method: 'GET', agent: false,
    headers: { Accept: 'application/json', Connection: 'close' },
  }, body: undefined });
  const operation = operationFor(snapshot());
  const releasing = fakeTransport({ value: { status: 'acknowledged' } });
  await callLicenseRpc('/release', operation, { request: releasing.request });
  assert.deepEqual(releasing.calls[0], { options: {
    socketPath: SOCKET_PATH, path: '/release', method: 'POST', agent: false,
    headers: { Accept: 'application/json', Connection: 'close', 'Content-Type': 'application/json' },
  }, body: JSON.stringify(operation) });
  let forbiddenCalls = 0;
  const forbidden = () => { forbiddenCalls++; };
  for (const [route, value] of [['/anything', undefined], ['/release', undefined], ['/snapshot', operation],
    ['https://example.invalid/release', operation]]) {
    assert.throws(() => callLicenseRpc(route, value, { request: forbidden }), { code: 'invalid_operation' });
  }
  assert.equal(forbiddenCalls, 0);
});

test('RPC rejects malformed JSON, non-object JSON, HTML, redirects, 401 and 403', async () => {
  for (const [parameters, code] of [
    [{ body: '{broken' }, 'invalid_response'],
    [{ body: 'null' }, 'invalid_response'],
    [{ body: '[]' }, 'invalid_response'],
    [{ body: '"text"' }, 'invalid_response'],
    [{ contentType: 'text/html' }, 'invalid_response'],
    [{ contentType: 'application/jsonp' }, 'invalid_response'],
    [{ statusCode: 302 }, 'invalid_response'],
    [{ statusCode: 401, value: { status: 'needs_login' } }, 'needs_login'],
    [{ statusCode: 403, value: { status: 'access_denied' } }, 'access_denied'],
    [{ statusCode: 502, value: { status: 'error', code: 'wrong_tenant' } }, 'wrong_tenant'],
    [{ statusCode: 500, value: { status: 'error', code: 'synthetic-secret' } }, 'invalid_response'],
  ]) {
    const transport = fakeTransport(parameters);
    await assert.rejects(callLicenseRpc('/snapshot', undefined, { request: transport.request }), { code });
    assert.equal(transport.callbackError(), undefined, 'response callback must not throw outside the promise');
    assert.equal(transport.calls.length, 1);
  }
});

test('RPC enforces the inclusive 128 KiB response limit and destroys oversized responses', async () => {
  const base = JSON.stringify({ status: 'ok', snapshot: snapshot() });
  const allowed = fakeTransport({ body: base + ' '.repeat(131072 - Buffer.byteLength(base)) });
  assert.equal((await callLicenseRpc('/snapshot', undefined, { request: allowed.request })).status, 'ok');
  const oversized = fakeTransport({ body: base + ' '.repeat(131073 - Buffer.byteLength(base)) });
  await assert.rejects(callLicenseRpc('/snapshot', undefined, { request: oversized.request }), { code: 'invalid_response' });
  assert.equal(oversized.responseObject().destroyed, true);
  assert.equal(oversized.requestObject().destroyed, true);
  assert.equal(oversized.calls.length, 1);
});

test('RPC transport and response failures reject once without leaking raw errors or retrying', async () => {
  for (const parameters of [{ requestFailure: true }, { responseFailure: true }]) {
    const transport = fakeTransport(parameters);
    await assert.rejects(callLicenseRpc('/snapshot', undefined, { request: transport.request }), error => {
      assert.equal(error.code, 'transport_error');
      assert.doesNotMatch(error.message, /Cookie|synthetic-secret/);
      return true;
    });
    assert.equal(transport.calls.length, 1);
    assert.equal(transport.requestObject().destroyed, true);
  }
});

test('synchronous request failure clears its deadline and returns only the safe transport error', async t => {
  let cleared = false;
  const timer = {};
  t.mock.method(globalThis, 'setTimeout', (_callback, delay) => { assert.equal(delay, 40_000); return timer; });
  t.mock.method(globalThis, 'clearTimeout', value => { assert.equal(value, timer); cleared = true; });
  let calls = 0;
  await assert.rejects(callLicenseRpc('/snapshot', undefined, { request: () => {
    calls++; throw new Error('Cookie: synthetic-secret');
  } }), error => {
    assert.equal(error.code, 'transport_error');
    assert.doesNotMatch(error.message, /Cookie|synthetic-secret/);
    return true;
  });
  assert.equal(cleared, true);
  assert.equal(calls, 1);
});

test('the one RPC deadline destroys a stalled request without retrying', async t => {
  let expire;
  let cleared = false;
  const timer = {};
  t.mock.method(globalThis, 'setTimeout', (callback, delay) => { assert.equal(delay, 40_000); expire = callback; return timer; });
  t.mock.method(globalThis, 'clearTimeout', value => { assert.equal(value, timer); cleared = true; });
  const transport = fakeTransport({ hang: true });
  const pending = callLicenseRpc('/snapshot', undefined, { request: transport.request });
  expire();
  await assert.rejects(pending, { code: 'timeout' });
  assert.equal(cleared, true);
  assert.equal(transport.requestObject().destroyed, true);
  assert.equal(transport.calls.length, 1);
});
