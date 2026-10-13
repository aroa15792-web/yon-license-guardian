import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { TARGET, fingerprint } from '../../src/policy.mjs';
import { browserMode, buildSummaryEvaluation, createSummaryHandler, sanitizeResult } from './session.mjs';

const source = await readFile(new URL('../../src/license-summary.mjs', import.meta.url), 'utf8');
const script = buildSummaryEvaluation(source);
const valid = { status: 'ok', summary: {
  kind: 'procurement-license-summary', capacity: 10, used: 2, full: false, observedAt: 1,
} };
const target = 'https://c3.yonyoucloud.com/';
const request = (handler, method = 'GET', url = '/summary') => new Promise(resolve => {
  const response = { destroyed: false, writeHead(status) { this.status = status; },
    end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } };
  handler({ method, url }, response);
});

test('only fixed modes and summary route are accepted', async () => {
  assert.equal(browserMode(), 'summary');
  assert.equal(browserMode('login'), 'login');
  assert.throws(() => browserMode('https://example.com'));
  let evaluations = 0;
  const handler = createSummaryHandler({ pages: () => [{ frames: () => [{
    url: () => target, evaluate: () => { evaluations++; return valid; },
  }] }] }, script);
  assert.equal((await request(handler, 'POST')).status, 405);
  assert.equal((await request(handler, 'GET', '/summary?url=anything')).status, 404);
  assert.equal((await request(handler, 'GET', '/release')).status, 405);
  assert.equal((await request(handler, 'POST', '/release')).status, 403);
  assert.equal(evaluations, 0);
  assert.deepEqual((await request(handler)).body, valid);
  assert.equal(evaluations, 1);
});

test('missing c3 frame needs login without evaluation', async () => {
  const handler = createSummaryHandler({ pages: () => [{ frames: () => [{
    url: () => 'https://www.yonyoucloud.com/', evaluate() { assert.fail('must not evaluate'); },
  }] }] }, script);
  assert.deepEqual(await request(handler), { status: 401, body: { status: 'needs_login' } });
});

test('read recovery restores a missing c3 frame then performs the original safe read', async () => {
  let restored = false, recoveries = 0, reads = 0;
  const context = { pages: () => [{ frames: () => restored ? [{
    url: () => target, evaluate: () => { reads++; return valid; },
  }] : [] }] };
  const handler = createSummaryHandler(context, script, { recoverLogin: async () => {
    recoveries++; restored = true; return { status: 'ok' };
  } });
  assert.deepEqual(await request(handler), { status: 200, body: valid });
  assert.equal(recoveries, 1); assert.equal(reads, 1);
});

test('authentication recovery never occurs for a release RPC', async () => {
  let recoveries = 0;
  const handler = createSummaryHandler({ pages: () => [] }, script, {
    releaseEnabled: true, recoverLogin: async () => { recoveries++; return { status: 'ok' }; },
  });
  assert.deepEqual(await request(handler, 'POST', '/release'), { status: 401, body: { status: 'needs_login' } });
  assert.equal(recoveries, 0);
});

test('challenge recovery remains unauthenticated and does not retry the read', async () => {
  let reads = 0, recoveries = 0;
  const handler = createSummaryHandler({ pages: () => [{ frames: () => [{
    url: () => target, evaluate: () => { reads++; return { status: 'needs_login' }; },
  }] }] }, script, { recoverLogin: async () => {
    recoveries++; return { status: 'manual_login_required', code: 'challenge' };
  } });
  assert.deepEqual(await request(handler), { status: 401, body: { status: 'needs_login' } });
  assert.equal(reads, 1); assert.equal(recoveries, 1);
});

test('a timed-out login recovery cannot start a late read', async () => {
  let reads = 0, complete;
  // Begin without a c3 frame; publish it only after the HTTP deadline.
  const empty = { pages: () => [] };
  const delayed = createSummaryHandler(empty, script, {
    timeoutMs: 10, recoverLogin: () => new Promise(resolve => { complete = resolve; }),
  });
  assert.equal((await request(delayed)).status, 504);
  empty.pages = () => [{ frames: () => [{ url: () => target, evaluate: () => { reads++; return valid; } }] }];
  complete({ status: 'ok' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0);
});

test('summary output drops URLs, tenant identities and arbitrary fields', () => {
  assert.deepEqual(sanitizeResult({ ...valid, tenant: 'private', summary: {
    ...valid.summary, url: 'https://private.invalid', records: ['private'],
  } }), valid);
  assert.deepEqual(sanitizeResult({ status: 'ok', summary: { ...valid.summary, used: -1 } }),
    { status: 'error', code: 'invalid_response' });
  assert.deepEqual(sanitizeResult({ status: 'error', code: 'private server response' }),
    { status: 'error', code: 'unknown' });
});

test('hung evaluation times out and stays locked against duplicate reads', async () => {
  let evaluations = 0;
  let complete;
  const handler = createSummaryHandler({ pages: () => [{ frames: () => [{
    url: () => target, evaluate: () => { evaluations++; return new Promise(resolve => { complete = resolve; }); },
  }] }] }, script, { timeoutMs: 10 });
  assert.equal((await request(handler)).status, 504);
  assert.equal((await request(handler)).status, 409);
  assert.equal(evaluations, 1);
  complete(valid);
});

async function evaluate(fetch) {
  return vm.runInNewContext(script, { location: { origin: target.slice(0, -1) }, fetch,
    AbortController, setTimeout, clearTimeout, console: { log() { assert.fail('no browser logging'); } } });
}

test('source HTTP 401 and 403 stay distinct and do not become zero', async () => {
  for (const [status, expected] of [[401, 'needs_login'], [403, 'access_denied']]) {
    let calls = 0;
    const result = await evaluate(async (url, options) => {
      calls++;
      assert.equal(options.credentials, 'same-origin');
      assert.equal(options.redirect, 'error');
      return { status, url, redirected: false, type: 'basic' };
    });
    assert.equal(result.status, expected);
    assert.equal(calls, 1);
  }
});

test('successful source response uses one fixed GET and exposes summary fields only', async () => {
  let calls = 0;
  const result = await evaluate(async (url, options) => {
    calls++;
    assert.equal(url, 'https://c3.yonyoucloud.com/iuap-apcom-workbench/manager/license/getTenantLicenseInfo?labelDomain=MM&status=VALID');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Accept, 'application/json');
    assert.equal(options.headers.isAjax, '1');
    return { status: 200, url, redirected: false, type: 'basic',
      headers: { get: () => 'application/json; charset=utf-8' },
      json: async () => ({ status: 1, tenant: 'private', data: [{
        code: 'BIP0002YB', type: 'SHAREUSER', name: '专业应用用户数', amount: 10, usedAmount: 2,
        records: ['private'], controlPoints: [{ code: 'BIPSCM0201', labelDomain: 'MM',
          status: 'VALID', relyUserMaterial: 'BIP0002YB' }],
      }] }),
    };
  });
  const clean = sanitizeResult(result);
  assert.equal(calls, 1);
  assert.equal(clean.status, 'ok');
  assert.deepEqual({ ...clean.summary, observedAt: 1 }, valid.summary);
  assert.deepEqual(Object.keys(clean.summary).sort(), ['capacity', 'full', 'kind', 'observedAt', 'used']);
  assert.equal(JSON.stringify(clean).includes('private'), false);
});

test('business login-expired responses remain needs_login', async () => {
  for (const body of [{ needrelogin: true }, { errorCode: '000001' }]) {
    const result = await evaluate(async url => ({ status: 200, url, redirected: false, type: 'basic',
      headers: { get: () => 'application/json' }, json: async () => body,
    }));
    assert.deepEqual(sanitizeResult(result), { status: 'needs_login' });
  }
});

test('network failure is an error, never successful zero occupancy', async () => {
  const result = await evaluate(async () => { throw new Error('private transport detail'); });
  assert.equal(result.status, 'error');
  assert.equal(result.code, 'transport_error');
  assert.equal(JSON.stringify(result).includes('private'), false);
});

test('invalid summary source cannot introduce module imports', () => {
  assert.throws(() => buildSummaryEvaluation('import fs from "node:fs";'));
});

test('pinned tenant mismatch stops before the licence request', async () => {
  assert.throws(() => buildSummaryEvaluation(source, { expectedTenantHash: 'invalid' }));
  const guarded = buildSummaryEvaluation(source, { expectedTenantHash: '0'.repeat(64) });
  let calls = 0;
  const result = await vm.runInNewContext(guarded, {
    location: { origin: target.slice(0, -1) }, AbortController, setTimeout, clearTimeout,
    crypto: webcrypto, TextEncoder,
    fetch: async url => {
      calls++;
      assert.equal(url.includes('getTenantLicenseInfo'), false);
      return { status: 200, url, redirected: false, type: 'basic',
        headers: { get: () => 'application/json' }, json: async () => ({ status: 1,
          data: url.includes('getUserInfo') ? { currentTeamConfig: { tenantId: 'tenant-a' }, company: 'Example' } : { tenantid: 'tenant-a' },
        }),
      };
    },
  });
  assert.deepEqual(sanitizeResult(result), { status: 'error', code: 'wrong_tenant' });
  assert.equal(calls, 3);
});

test('scope route uses only the fixed scope expression and sanitizes identity', async () => {
  const handler = createSummaryHandler({ pages: () => [{ frames: () => [{
    url: () => target, evaluate: actual => {
      assert.equal(actual, 'fixed-scope');
      return { status: 'ok', scope: { tenantHash: 'a'.repeat(64), company: 'Example', observedAt: 1, rawTenantId: 'private' } };
    },
  }] }] }, 'fixed-summary', { scopeScript: 'fixed-scope' });
  const response = await request(handler, 'GET', '/scope');
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(response).includes('private'), false);
  assert.equal((await request(handler, 'GET', '/scope?url=other')).status, 404);
});

test('release RPC requires the matching durable pending journal and is single use', async () => {
  const tenantHash = 'a'.repeat(64);
  const full = { ...TARGET, status: 'ok', scopeVerified: true, tenantKey: tenantHash,
    unfiltered: true, complete: true, observedAt: Date.now(), used: 10, licenseState: 'active',
    records: Array.from({ length: 10 }, (_, i) => ({ id: String(i).padStart(64, '0') })),
  };
  const token = '11111111-1111-4111-8111-111111111111';
  const operation = { tenantKey: tenantHash, ids: full.records.map(row => row.id),
    operationId: '22222222-2222-4222-8222-222222222222', expectedFingerprint: fingerprint(full) };
  let durable = null, writes = 0;
  const handler = createSummaryHandler({ pages: () => [{ frames: () => [{
    url: () => target, evaluate: script => {
      if (script === 'snapshot') return { status: 'ok', token, snapshot: full };
      writes++;
      return { status: 'acknowledged', headerMode: 'standard_json' };
    },
  }] }] }, 'summary', { snapshotScript: 'snapshot', expectedTenantHash: tenantHash,
    releaseEnabled: true, pendingJournal: { read: async () => durable } });
  const sendOperation = () => new Promise(resolve => {
    const req = { method: 'POST', url: '/release', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(operation)); } };
    handler(req, { destroyed: false, writeHead(status) { this.status = status; },
      end(body) { resolve({ status: this.status, body: JSON.parse(body) }); } });
  });
  await request(handler, 'GET', '/snapshot');
  assert.equal((await sendOperation()).status, 502);
  assert.equal(writes, 0);
  durable = { status: 'pending', operationId: operation.operationId,
    fingerprint: operation.expectedFingerprint, before: 10, at: Date.now() };
  assert.equal((await sendOperation()).body.status, 'acknowledged');
  assert.equal(writes, 1);
  assert.equal((await sendOperation()).status, 502);
  assert.equal(writes, 1);
  await request(handler, 'GET', '/snapshot');
  assert.equal((await sendOperation()).status, 502);
  assert.equal(writes, 1, 'a new read token cannot repeat the same pending operation');
});
