import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { buildTenantScopeEvaluation, sanitizeTenantScope } from './tenant-scope.mjs';

const meUrl = 'https://c3.yonyoucloud.com/iuap-apcom-workbench/me?onlyShayat=false';
const userUrl = 'https://c3.yonyoucloud.com/iuap-apcom-workbench/user/getUserInfo?userId=';
const tenant = 'synthetic-test-tenant';
const company = '示例企业';
const valid = [
  { tenantid: tenant },
  { currentTeamConfig: { tenantId: tenant }, company, userMobile: 'sensitive', userId: 'sensitive' },
  { tenantid: tenant },
];

async function run(data = valid, status = 200) {
  const calls = [];
  const result = await vm.runInNewContext(buildTenantScopeEvaluation(), {
    location: { origin: 'https://c3.yonyoucloud.com' },
    AbortController, setTimeout, clearTimeout, crypto: webcrypto, TextEncoder,
    fetch: async (url, options) => {
      const index = calls.length;
      calls.push({ url, options });
      return { status, url, redirected: false, type: 'basic',
        headers: { get: () => 'application/json; charset=utf-8' },
        json: async () => ({ status: 1, data: data[index] }),
      };
    },
  });
  return { result: sanitizeTenantScope(result), calls };
}

test('three ordered fixed GETs verify one tenant and return only hashed scope', async () => {
  const { result, calls } = await run();
  assert.deepEqual(calls.map(call => call.url), [meUrl, userUrl, meUrl]);
  for (const { options } of calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.isAjax, '1');
    assert.equal(options.signal.aborted, false);
  }
  assert.equal(result.status, 'ok');
  assert.equal(result.scope.tenantHash, createHash('sha256').update(tenant).digest('hex'));
  assert.equal(result.scope.company, company);
  assert.deepEqual(Object.keys(result.scope).sort(), ['company', 'observedAt', 'tenantHash']);
  assert.equal(JSON.stringify(result).includes(tenant), false);
  assert.equal(JSON.stringify(result).includes('sensitive'), false);
});

test('tenant switch or disagreement fails closed', async () => {
  for (const data of [
    [valid[0], valid[1], { tenantid: 'different-tenant' }],
    [valid[0], { ...valid[1], currentTeamConfig: { tenantId: 'different-tenant' } }, valid[2]],
  ]) {
    assert.deepEqual((await run(data)).result, { status: 'error', code: 'wrong_tenant' });
  }
});

test('401 and 403 stop immediately without further reads', async () => {
  for (const [status, expected] of [[401, 'needs_login'], [403, 'access_denied']]) {
    const { result, calls } = await run(valid, status);
    assert.deepEqual(result, { status: expected });
    assert.equal(calls.length, 1);
  }
});

test('sanitizer discards raw IDs, personnel fields and exception text', () => {
  const scope = { tenantHash: 'a'.repeat(64), company, observedAt: 1 };
  assert.deepEqual(sanitizeTenantScope({ status: 'ok', tenantId: tenant,
    scope: { ...scope, tenantId: tenant, userMobile: 'sensitive' } }), { status: 'ok', scope });
  assert.deepEqual(sanitizeTenantScope({ status: 'error', code: 'sensitive', message: 'sensitive' }),
    { status: 'error', code: 'unknown' });
  assert.deepEqual(sanitizeTenantScope({ status: 'ok', scope: { ...scope, company: 'x'.repeat(161) } }),
    { status: 'error', code: 'invalid_response' });
});
