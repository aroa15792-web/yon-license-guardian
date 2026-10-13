import { TARGET } from '../../src/policy.mjs';
import { SNAPSHOT_REGISTRY_SYMBOL } from './license-adapter.mjs';

const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

// The command carries only opaque hashes. Real licence userIds remain inside
// the browser registry created by the complete, scope-verified read adapter.
export function buildReleaseEvaluation(input) {
  return buildScopedReleaseEvaluation(input, TARGET.capacity);
}

// Dedicated one-shot CLI entry only. Callers must durably record and consume
// the user-authorized test before invoking it; automatic release stays at 10.
export function buildManualTestReleaseEvaluation(input) {
  return buildScopedReleaseEvaluation(input, 1);
}

function buildScopedReleaseEvaluation(input, minimumUsed) {
  const keys = ['token', 'ids', 'tenantKey', 'operationId', 'expectedFingerprint'];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).length !== keys.length || !keys.every(key => Object.hasOwn(input, key)) ||
      typeof input.token !== 'string' || !UUID.test(input.token) ||
      typeof input.operationId !== 'string' || !UUID.test(input.operationId) ||
      typeof input.tenantKey !== 'string' || !HASH.test(input.tenantKey) ||
      typeof input.expectedFingerprint !== 'string' || !HASH.test(input.expectedFingerprint) ||
      !Array.isArray(input.ids) || input.ids.length < minimumUsed || input.ids.length > 1000 ||
      input.ids.some(id => typeof id !== 'string' || !HASH.test(id)) || new Set(input.ids).size !== input.ids.length) {
    throw new TypeError('invalid_release_request');
  }
  const command = Object.fromEntries(keys.map(key => [key, key === 'ids' ? [...input.ids] : input[key]]));
  return `(async () => {
    const command = ${JSON.stringify(command)};
    const target = ${JSON.stringify(TARGET)};
    const minimumUsed = ${minimumUsed};
    const releaseUrl = 'https://c3.yonyoucloud.com/iuap-apcom-workbench/manager/license/remove';
    const codes = ['invalid_token','expired_token','invalid_snapshot','wrong_tenant','wrong_target',
      'incomplete_list','unsafe_user_id','fingerprint_mismatch','invalid_headers','needs_login',
      'access_denied','invalid_response','http_error','verification_required','business_rejected',
      'timeout','transport_error','unknown'];
    const fail = code => { throw {releaseCode:code}; };
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2,'0')).join('');
    const abort = new AbortController();
    const startedAt = Date.now();
    let expired = false;
    let timer;
    let sent = false;
    let headerMode = 'standard_json';
    let claimed;
    const fresh = () => {
      const now = Date.now();
      if (expired || now < startedAt || now - startedAt >= 15000) fail('timeout');
      if (claimed && (now < claimed.snapshot.observedAt || now >= claimed.expiresAt)) fail('expired_token');
    };
    const deadline = new Promise((_,reject) => {
      timer = setTimeout(() => { expired = true; reject({releaseCode:'timeout'}); abort.abort(); },15000);
    });
    try {
      return await Promise.race([deadline, (async () => {
        if (location.origin !== target.origin) fail('wrong_target');
        const registry = globalThis[Symbol.for(${JSON.stringify(SNAPSHOT_REGISTRY_SYMBOL)})];
        if (!(registry instanceof Map) || !registry.has(command.token)) fail('invalid_token');
        // Consume synchronously before the first await. Validation failure and
        // ambiguous transport outcomes must not leave a reusable write token.
        const entry = registry.get(command.token);
        registry.delete(command.token);
        if (!record(entry) || !record(entry.snapshot) || !(entry.idsByHash instanceof Map)) fail('invalid_snapshot');
        const snapshot = entry.snapshot;
        if (entry.tenantKey !== command.tenantKey || snapshot.tenantKey !== command.tenantKey) fail('wrong_tenant');
        if (snapshot.status !== 'ok' || snapshot.scopeVerified !== true || snapshot.complete !== true ||
            snapshot.unfiltered !== true || snapshot.licenseState !== 'active') fail('invalid_snapshot');
        for (const [key,value] of Object.entries(target)) {
          if (!Object.hasOwn(snapshot,key) || snapshot[key] !== value) fail('wrong_target');
        }
        if (!Number.isSafeInteger(snapshot.observedAt) || snapshot.observedAt < 0 ||
            !Number.isSafeInteger(entry.expiresAt) || entry.expiresAt !== snapshot.observedAt + 30000) fail('expired_token');
        claimed = entry;
        fresh();
        if (!Number.isSafeInteger(snapshot.used) || snapshot.used < minimumUsed || snapshot.used > 1000 ||
            !Array.isArray(snapshot.records) || snapshot.records.length !== snapshot.used ||
            entry.idsByHash.size !== snapshot.used || command.ids.length !== snapshot.used) fail('incomplete_list');
        const observedIds = snapshot.records.map(row => record(row) ? row.id : undefined);
        if (observedIds.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) ||
            new Set(observedIds).size !== observedIds.length) fail('incomplete_list');
        const requested = new Set(command.ids);
        if (observedIds.some(id => !requested.has(id) || !entry.idsByHash.has(id))) fail('incomplete_list');
        const actualIds = [];
        const actualSeen = new Set();
        for (const id of command.ids) {
          const actual = entry.idsByHash.get(id);
          if (typeof actual !== 'string' || !actual.trim() || actual.length > 128 ||
              /[,\\x00-\\x1f\\x7f]/.test(actual) || actualSeen.has(actual)) fail('unsafe_user_id');
          if (await hash(JSON.stringify([command.tenantKey,target.licenseCode,actual])) !== id) fail('unsafe_user_id');
          actualSeen.add(actual);
          actualIds.push(actual);
          fresh();
        }
        const observedFingerprint = await hash(JSON.stringify({
          tenantKey:snapshot.tenantKey,
          ...Object.fromEntries(Object.keys(target).map(key => [key,snapshot[key]])),
          ids:[...observedIds].sort(),
        }));
        if (observedFingerprint !== command.expectedFingerprint) fail('fingerprint_mismatch');
        fresh();
        const params = {userId:actualIds.join(','),code:target.licenseCode};
        const headers = new Headers({Accept:'application/json','Content-Type':'application/json;charset=utf-8',
          'Domain-Key':'u8c-auth',isAjax:'1'});
        const rest = globalThis.cb?.rest;
        if (typeof rest?.setCommonHeaders === 'function') {
          headerMode = 'native_mdf';
          const allowed = new Set(['x-xsrf-token','x-xsrf-token2','x-request-time','dynamic-auth-token']);
          const bridge = {setRequestHeader(name,value) {
            if (typeof name !== 'string' || !allowed.has(name.toLowerCase()) ||
                !['string','number'].includes(typeof value) || String(value).length === 0 ||
                /[\\r\\n]/.test(String(value)) || ['MDF_NO_TNSSDK','MDF_NO_TNSSDK_METHOD'].includes(String(value))) {
              fail('invalid_headers');
            }
            headers.set(name,String(value));
          }};
          try { rest.setCommonHeaders({xhr:bridge,url:releaseUrl,options:{domainKey:'u8c-auth',uniform:false,params}}); }
          catch { fail('invalid_headers'); }
          if (!headers.has('x-xsrf-token')) fail('invalid_headers');
        }
        fresh();
        // The native proxy is deliberately not invoked: its generic handlers
        // can resend requests after secondary verification or confirmation.
        sent = true;
        let response;
        try {
          response = await fetch(releaseUrl,{method:'POST',credentials:'same-origin',redirect:'error',
            cache:'no-store',headers,body:JSON.stringify(params),signal:abort.signal});
        } catch { fail(expired ? 'timeout' : 'transport_error'); }
        if (expired) fail('timeout');
        if (response.status === 401) fail('needs_login');
        if (response.status === 403) fail('access_denied');
        if (response.status === 471) fail('verification_required');
        if (response.status !== 200) fail('http_error');
        if (response.url !== releaseUrl || response.redirected !== false || response.type === 'opaqueredirect') fail('invalid_response');
        const mediaType = response.headers?.get?.('content-type')?.split(';',1)[0].trim().toLowerCase();
        if (!mediaType || !/^application\\/(?:[a-z0-9!#$&^_.+-]+\\+)?json$/.test(mediaType)) fail('invalid_response');
        let body;
        try { body = await response.json(); } catch { fail(expired ? 'timeout' : 'invalid_response'); }
        if (expired) fail('timeout');
        if (!record(body)) fail('invalid_response');
        if (body.needrelogin === true || body.errorCode === '000001') fail('needs_login');
        if ([987,471].includes(body.code) || [987,471].includes(body.status)) fail('verification_required');
        if ((Object.hasOwn(body,'status') && body.status !== 1) ||
            (Object.hasOwn(body,'code') && body.code !== 200) ||
            (body.status !== 1 && body.code !== 200)) fail('business_rejected');
        return {status:'acknowledged',headerMode};
      })()]);
    } catch (error) {
      const reason = codes.includes(error?.releaseCode) ? error.releaseCode : 'unknown';
      return sent ? {status:'error',code:'reconciliation_required',reason,headerMode} : {status:'error',code:reason};
    } finally { clearTimeout(timer); }
  })()`;
}
