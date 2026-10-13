import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { TARGET, fingerprint } from '../../src/policy.mjs';
import { SNAPSHOT_REGISTRY_SYMBOL } from './license-adapter.mjs';
import { buildReleaseEvaluation, buildManualTestReleaseEvaluation } from './release-operation.mjs';

const now = 1_800_000_000_000;
const token = '01234567-89ab-4cde-8f01-23456789abcd';
const operationId = '11234567-89ab-4cde-8f01-23456789abcd';
const tenantKey = 'a'.repeat(64);
const releaseUrl = 'https://c3.yonyoucloud.com/iuap-apcom-workbench/manager/license/remove';
const digest = value => createHash('sha256').update(value).digest('hex');

function browser({ adjust, status = 200, body = { status: 1 }, mediaType = 'application/json', helper, transport,
  used = 10, builder = buildReleaseEvaluation } = {}) {
  const actualIds = Array.from({ length: used }, (_, i) => `synthetic-private-user-${i}`);
  const pairs = actualIds.map(id => [digest(JSON.stringify([tenantKey,TARGET.licenseCode,id])),id]);
  const snapshot = { ...TARGET, status:'ok', tenantKey, scopeVerified:true, complete:true, unfiltered:true,
    licenseState:'active', observedAt:now, used, records:pairs.map(([id]) => ({ id })) };
  const command = { token, ids:pairs.map(([id]) => id), tenantKey, operationId, expectedFingerprint:fingerprint(snapshot) };
  const calls = [];
  const context = vm.createContext({
    location:{origin:TARGET.origin}, crypto:webcrypto, TextEncoder, Headers, AbortController,
    setTimeout, clearTimeout, Date:class extends Date { static now() { return now; } },
    fixture:{token,entry:{expiresAt:now+30000,tenantKey,snapshot},pairs},
    ...(helper ? {cb:{rest:{setCommonHeaders:helper}}} : {}),
    fetch: async (url,options) => {
      calls.push({url,options});
      if (transport) return transport(url,options);
      return {status,url,redirected:false,type:'basic',headers:{get:() => mediaType},json:async () => body};
    },
  });
  vm.runInContext(`globalThis[Symbol.for(${JSON.stringify(SNAPSHOT_REGISTRY_SYMBOL)})] = new Map([
    [fixture.token,{...fixture.entry,idsByHash:new Map(fixture.pairs)}]
  ]);`,context);
  const entry = vm.runInContext(`globalThis[Symbol.for(${JSON.stringify(SNAPSHOT_REGISTRY_SYMBOL)})].get(fixture.token)`,context);
  adjust?.({entry,command,pairs,actualIds});
  return {actualIds,calls,command,entry,
    run:async () => JSON.parse(JSON.stringify(await vm.runInContext(builder(command),context))),
    hasToken:() => vm.runInContext(`globalThis[Symbol.for(${JSON.stringify(SNAPSHOT_REGISTRY_SYMBOL)})].has(fixture.token)`,context),
  };
}

test('one fixed JSON request uses every registry userId and consumes its token', async () => {
  const b = browser();
  const result = await b.run();
  assert.deepEqual(result,{status:'acknowledged',headerMode:'standard_json'});
  assert.equal(b.calls.length,1);
  const {url,options} = b.calls[0];
  assert.equal(url,releaseUrl);
  assert.equal(options.method,'POST');
  assert.equal(options.credentials,'same-origin');
  assert.equal(options.redirect,'error');
  assert.equal(options.cache,'no-store');
  assert.equal(options.headers.get('content-type'),'application/json;charset=utf-8');
  assert.equal(options.headers.get('domain-key'),'u8c-auth');
  assert.equal(options.headers.get('isAjax'),'1');
  assert.deepEqual(JSON.parse(options.body),{userId:b.actualIds.join(','),code:'BIP0002YB'});
  assert.equal(JSON.stringify(result).includes('synthetic-private'),false);
  assert.equal(b.hasToken(),false);
  assert.deepEqual(await b.run(),{status:'error',code:'invalid_token'});
  assert.equal(b.calls.length,1);
});

test('builder rejects dynamic URLs, partial IDs, duplicates and non-hash IDs', () => {
  const b = browser();
  const variants = [
    {...b.command,url:'https://example.invalid'},
    {...b.command,ids:b.command.ids.slice(1)},
    {...b.command,ids:Array(10).fill(b.command.ids[0])},
    {...b.command,ids:['raw,user-id',...b.command.ids.slice(1)]},
    {...b.command,operationId:'not-an-operation-id'},
  ];
  for (const request of variants) assert.throws(() => buildReleaseEvaluation(request),/invalid_release_request/);
  assert.equal(b.calls.length,0);
});

test('registry scope, fullness, freshness, IDs and fingerprint are checked before sending', async () => {
  const cases = [
    ({entry}) => { entry.expiresAt = now; },
    ({entry}) => { entry.tenantKey = 'b'.repeat(64); },
    ({entry}) => { entry.snapshot.complete = false; },
    ({entry}) => { entry.snapshot.used = 9; },
    ({entry}) => { entry.snapshot.licenseCode = 'BIP0002XX'; },
    ({entry,command}) => { entry.idsByHash.set(command.ids[0],'unsafe,user'); },
    ({entry,command}) => { entry.idsByHash.set(command.ids[0],'substituted-private-user'); },
    ({command}) => { command.ids[0] = 'b'.repeat(64); },
    ({command}) => { command.expectedFingerprint = 'b'.repeat(64); },
  ];
  for (const adjust of cases) {
    const b = browser({adjust});
    assert.equal((await b.run()).status,'error');
    assert.equal(b.calls.length,0);
    assert.equal(b.hasToken(),false);
  }
});

test('HTTP auth failures and secondary verification never acknowledge or retry', async () => {
  for (const status of [401,403,471]) {
    const b = browser({status});
    const result = await b.run();
    assert.equal(result.status,'error');
    assert.equal(result.code,'reconciliation_required');
    assert.equal(b.calls.length,1);
    assert.equal(b.hasToken(),false);
    assert.equal((await b.run()).code,'invalid_token');
    assert.equal(b.calls.length,1);
  }
});

test('ambiguous, negative and conflicting business envelopes cannot acknowledge', async () => {
  for (const body of [null,[],{}, {message:'success'}, {status:0}, {status:'1'}, {code:500},
    {code:987}, {code:471}, {code:988}, {status:1,code:500}, {code:200,status:0}, {needrelogin:true}]) {
    const b = browser({body});
    const result = await b.run();
    assert.equal(result.code,'reconciliation_required');
    assert.equal(b.calls.length,1);
    assert.equal(b.hasToken(),false);
  }
  const b = browser({mediaType:'text/html'});
  assert.equal((await b.run()).code,'reconciliation_required');
  assert.equal(b.calls.length,1);
  assert.equal((await browser({body:{code:200,data:{}}}).run()).status,'acknowledged');
});

test('official header bridge keeps generated values within the request', async () => {
  let helperCalls = 0;
  const b = browser({helper:({xhr,url,options}) => {
    helperCalls++;
    assert.equal(url,releaseUrl);
    assert.equal(options.domainKey,'u8c-auth');
    xhr.setRequestHeader('X-XSRF-TOKEN','synthetic-sensitive-header');
    xhr.setRequestHeader('X-REQUEST-TIME',12345);
  }});
  const result = await b.run();
  assert.equal(helperCalls,1);
  assert.equal(b.calls.length,1);
  assert.equal(b.calls[0].options.headers.get('X-XSRF-TOKEN'),'synthetic-sensitive-header');
  assert.deepEqual(result,{status:'acknowledged',headerMode:'native_mdf'});
  assert.equal(JSON.stringify(result).includes('synthetic-sensitive-header'),false);
});

test('header-generation errors do not fall back or expose error details', async () => {
  for (const helper of [
    () => {},
    () => { throw new Error('synthetic-sensitive-header'); },
    ({xhr}) => xhr.setRequestHeader('Authorization','synthetic-sensitive-header'),
    ({xhr}) => xhr.setRequestHeader('X-XSRF-TOKEN','MDF_NO_TNSSDK'),
  ]) {
    const b = browser({helper});
    assert.deepEqual(await b.run(),{status:'error',code:'invalid_headers'});
    assert.equal(b.calls.length,0);
    assert.equal(b.hasToken(),false);
  }
});

test('uncertain transport sends once and retains no reusable token', async () => {
  const b = browser({transport:async () => { throw new Error('private transport details'); }});
  const result = await b.run();
  assert.deepEqual(result,{status:'error',code:'reconciliation_required',reason:'transport_error',headerMode:'standard_json'});
  assert.equal(b.calls.length,1);
  assert.equal(b.hasToken(),false);
  assert.equal((await b.run()).code,'invalid_token');
  assert.equal(b.calls.length,1);
});

test('dedicated manual test accepts complete 7/10 and 1/10 snapshots with one POST and no reusable token', async () => {
  for (const used of [7, 1]) {
    const b = browser({ used, builder: buildManualTestReleaseEvaluation });
    assert.deepEqual(await b.run(), { status: 'acknowledged', headerMode: 'standard_json' });
    assert.equal(TARGET.capacity, 10);
    assert.equal(b.entry.snapshot.capacity, 10);
    assert.equal(b.calls.length, 1);
    assert.equal(b.calls[0].url, releaseUrl);
    assert.equal(b.calls[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(b.calls[0].options.body), { userId: b.actualIds.join(','), code: 'BIP0002YB' });
    assert.equal(b.hasToken(), false);
    assert.deepEqual(await b.run(), { status: 'error', code: 'invalid_token' });
    assert.equal(b.calls.length, 1);
  }
});

test('automatic builder still rejects 7/10; neither entry accepts threshold or purpose overrides', async () => {
  const automatic = browser({ used: 7 });
  await assert.rejects(automatic.run(), /invalid_release_request/);
  assert.equal(automatic.calls.length, 0);
  const empty = browser({ used: 0, builder: buildManualTestReleaseEvaluation });
  await assert.rejects(empty.run(), /invalid_release_request/);
  assert.equal(empty.calls.length, 0);
  for (const builder of [buildReleaseEvaluation, buildManualTestReleaseEvaluation]) {
    const command = browser().command;
    for (const extra of [{ minimumUsed: 1 }, { capacity: 7 }, { purpose: 'manual-test' }, { test: true }]) {
      assert.throws(() => builder({ ...command, ...extra }), /invalid_release_request/);
    }
  }
});

test('manual test still rejects incomplete lists, wrong scope, expired tokens and changed fingerprints before POST', async () => {
  const cases = [
    [({ entry }) => { entry.snapshot.complete = false; }, 'invalid_snapshot'],
    [({ command }) => { command.ids.pop(); }, 'incomplete_list'],
    [({ entry }) => { entry.snapshot.capacity = 7; }, 'wrong_target'],
    [({ entry }) => { entry.snapshot.controlPointCode = 'BIPSCM9999'; }, 'wrong_target'],
    [({ entry }) => { entry.tenantKey = 'b'.repeat(64); }, 'wrong_tenant'],
    [({ entry }) => { entry.expiresAt = now; }, 'expired_token'],
    [({ command }) => { command.expectedFingerprint = 'b'.repeat(64); }, 'fingerprint_mismatch'],
  ];
  for (const [adjust, code] of cases) {
    const b = browser({ used: 7, builder: buildManualTestReleaseEvaluation, adjust });
    assert.deepEqual(await b.run(), { status: 'error', code });
    assert.equal(b.calls.length, 0);
    assert.equal(b.hasToken(), false);
  }
  const uncertain = browser({ used: 7, builder: buildManualTestReleaseEvaluation, status: 401 });
  assert.deepEqual(await uncertain.run(), {
    status: 'error', code: 'reconciliation_required', reason: 'needs_login', headerMode: 'standard_json',
  });
  assert.equal(uncertain.hasToken(), false);
  assert.equal((await uncertain.run()).code, 'invalid_token');
  assert.equal(uncertain.calls.length, 1);
});
