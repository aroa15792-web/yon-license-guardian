import { validate } from '../../src/policy.mjs';

export const SNAPSHOT_REGISTRY_SYMBOL = 'yon.license.snapshot.registry.v1';
export const LIST_URL = 'https://c3.yonyoucloud.com/iuap-apcom-auth/u8c-auth/bill/list?serviceCode=GZTSYS035&appCode=BIP0002YB&terminalType=1&fromYonyou=true';
const CODES = new Set([
  'wrong_tenant', 'invalid_response', 'wrong_target', 'invalid_count', 'http_error',
  'redirect', 'timeout', 'transport_error', 'incomplete_list', 'snapshot_changed',
  'unsafe_user_id', 'unknown',
]);
const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

// Returned script has only fixed read URLs. The list endpoint uses POST for its
// observed read-only query; there is no licence release or account mutation here.
export function buildReadSnapshotEvaluation({ expectedTenantHash, summarySource } = {}) {
  if (typeof expectedTenantHash !== 'string' || !HASH.test(expectedTenantHash)) throw new TypeError('invalid_tenant_hash');
  if (typeof summarySource !== 'string') throw new TypeError('invalid_summary_source');
  const source = summarySource.replace(/^export (?=(?:const|class|function)\b)/gm, '');
  if (/^\s*(?:import|export)\b/m.test(source)) throw new TypeError('invalid_summary_source');
  return `(async () => {
    if (location.origin !== 'https://c3.yonyoucloud.com') return {status:'needs_login'};
    const expectedTenantHash = ${JSON.stringify(expectedTenantHash)};
    const listUrl = ${JSON.stringify(LIST_URL)};
    const registryKey = Symbol.for(${JSON.stringify(SNAPSHOT_REGISTRY_SYMBOL)});
    const summaryLib = (() => { ${source}\n return {parseLicenseSummary, SUMMARY_URL}; })();
    const abort = new AbortController();
    const startedAt = Date.now();
    let expired = false;
    let timer;
    const fail = code => { throw {adapterCode:code}; };
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
    const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2,'0')).join('');
    const fresh = () => { if (expired || Date.now() < startedAt || Date.now() - startedAt >= 30000) fail('timeout'); };
    const read = async (url, body) => {
      fresh();
      let response;
      try {
        response = await fetch(url, {
          method: body === undefined ? 'GET' : 'POST', credentials:'same-origin',
          cache:'no-store', redirect:'error', signal:abort.signal,
          headers: {Accept:'application/json', isAjax:'1', ...(body === undefined ? {} : {'Content-Type':'application/json'})},
          ...(body === undefined ? {} : {body:JSON.stringify(body)}),
        });
      } catch { fail(expired ? 'timeout' : 'transport_error'); }
      fresh();
      if (response.status === 401) fail('needs_login');
      if (response.status === 403) fail('access_denied');
      if (response.redirected !== false || response.url !== url || response.type === 'opaqueredirect') fail('redirect');
      if (response.status !== 200) fail('http_error');
      const mediaType = response.headers?.get?.('content-type')?.split(';',1)[0].trim().toLowerCase();
      if (!mediaType || !/^application\\/(?:[a-z0-9!#$&^_.+-]+\\+)?json$/.test(mediaType)) fail('invalid_response');
      let payload;
      try { payload = await response.json(); } catch { fail(expired ? 'timeout' : 'invalid_response'); }
      fresh();
      if (payload?.needrelogin === true || payload?.errorCode === '000001') fail('needs_login');
      if (!record(payload)) fail('invalid_response');
      return payload;
    };
    const scopedData = async url => {
      const payload = await read(url);
      if (payload.status !== 1 || !record(payload.data)) fail('invalid_response');
      return payload.data;
    };
    const scope = async () => {
      const meUrl = 'https://c3.yonyoucloud.com/iuap-apcom-workbench/me?onlyShayat=false';
      const before = await scopedData(meUrl);
      const user = await scopedData('https://c3.yonyoucloud.com/iuap-apcom-workbench/user/getUserInfo?userId=');
      const after = await scopedData(meUrl);
      const a = before.tenantid;
      const b = record(user.currentTeamConfig) ? user.currentTeamConfig.tenantId : undefined;
      const c = after.tenantid;
      if (!identifier(a) || !identifier(b) || !identifier(c)) fail('invalid_response');
      if (a !== b || a !== c || await hash(a) !== expectedTenantHash) fail('wrong_tenant');
      fresh();
    };
    const statistics = async () => {
      const payload = await read(summaryLib.SUMMARY_URL);
      let parsed;
      try { parsed = summaryLib.parseLicenseSummary(payload); } catch (error) { fail(error?.code ?? 'invalid_response'); }
      const group = payload.data.find(item => item.code === parsed.source.licenseCode);
      const point = group.controlPoints[0];
      if (point.name !== '供应链云-采购供应-采购管理') fail('wrong_target');
      return {
        origin:location.origin, dashboard:'应用许可看板', domain:point.name.split('-')[0],
        metric:group.name, licenseCode:group.code, licenseType:group.type,
        controlPointCode:point.code, labelDomain:point.labelDomain,
        capacity:group.amount, used:group.usedAmount,
        licenseState:point.status === 'VALID' ? 'active' : 'invalid',
      };
    };
    const listPage = async pageIndex => {
      const payload = await read(listUrl, {
        billnum:'sys_user_licenselist', ownDomain:'u8c-auth', serviceCode:'GZTSYS035', appCode:'BIP0002YB',
        page:{pageIndex,pageSize:20},
        condition:{bInit:true, commonVOs:[{itemName:'schemeName',value1:'默认方案'},{itemName:'isDefault',value1:true}]},
        bEmptyWithoutFilterTree:true,
      });
      if (payload.code !== 200 || !record(payload.data)) fail('invalid_response');
      const page = payload.data;
      if (page.pageIndex !== pageIndex || page.pageSize !== 20 ||
          !Number.isSafeInteger(page.recordCount) || page.recordCount < 0 || page.recordCount > 1000 ||
          !Number.isSafeInteger(page.pageCount) || page.pageCount < 0 ||
          !Array.isArray(page.recordList)) fail('incomplete_list');
      const expectedPages = Math.ceil(page.recordCount / 20);
      if (page.recordCount === 0 ? ![0,1].includes(page.pageCount) : page.pageCount !== expectedPages) fail('incomplete_list');
      const expectedRows = Math.max(0, Math.min(20, page.recordCount - (pageIndex - 1) * 20));
      if (page.recordList.length !== expectedRows) fail('incomplete_list');
      return page;
    };
    const deadline = new Promise((_,reject) => {
      timer = setTimeout(() => { expired = true; reject({adapterCode:'timeout'}); abort.abort(); },30000);
    });
    let registry;
    try {
      if (globalThis[registryKey] === undefined) Object.defineProperty(globalThis,registryKey,{value:new Map(),writable:false,configurable:false});
      registry = globalThis[registryKey];
      if (!(registry instanceof Map)) fail('invalid_response');
      // A failed or changed new observation invalidates all previous write tokens.
      registry.clear();
      return await Promise.race([deadline, (async () => {
        await scope();
        const before = await statistics();
        const first = await listPage(1);
        if (first.recordCount !== before.used) fail('snapshot_changed');
        const rows = [...first.recordList];
        for (let index = 2; index <= first.pageCount; index++) {
          const page = await listPage(index);
          if (page.recordCount !== first.recordCount || page.pageCount !== first.pageCount) fail('snapshot_changed');
          rows.push(...page.recordList);
        }
        if (rows.length !== before.used) fail('incomplete_list');
        const idsByHash = new Map();
        const seen = new Set();
        for (const row of rows) {
          const id = record(row) ? row.userId : undefined;
          if (typeof id !== 'string' || id.trim().length === 0 || id.length > 128 || /[,\\x00-\\x1f\\x7f]/.test(id)) fail('unsafe_user_id');
          if (seen.has(id)) fail('incomplete_list');
          seen.add(id);
          const hashed = await hash(JSON.stringify([expectedTenantHash,before.licenseCode,id]));
          if (idsByHash.has(hashed)) fail('incomplete_list');
          idsByHash.set(hashed,id);
          fresh();
        }
        const after = await statistics();
        if (JSON.stringify(before) !== JSON.stringify(after)) fail('snapshot_changed');
        await scope();
        fresh();
        const observedAt = Date.now();
        const token = crypto.randomUUID();
        const snapshot = {
          status:'ok', ...after, scopeVerified:true, tenantKey:expectedTenantHash,
          unfiltered:true, complete:true, observedAt,
          records:Array.from(idsByHash.keys(),id => ({id})),
        };
        registry.set(token,{expiresAt:observedAt+30000,tenantKey:expectedTenantHash,idsByHash,snapshot});
        return {status:'ok',token,snapshot};
      })()]);
    } catch (error) {
      if (registry instanceof Map) registry.clear();
      const code = error?.adapterCode;
      if (code === 'needs_login' || code === 'access_denied') return {status:code};
      return {status:'error',code:${JSON.stringify([...CODES])}.includes(code) ? code : 'unknown'};
    } finally { clearTimeout(timer); }
  })()`;
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value,key));
}

export function sanitizeReadSnapshot(value, { expectedTenantHash, now = Date.now() } = {}) {
  if (exactKeys(value,['status']) && ['needs_login','access_denied'].includes(value.status)) return {status:value.status};
  if (exactKeys(value,['status','code']) && value.status === 'error') return {status:'error',code:CODES.has(value.code) ? value.code : 'unknown'};
  const invalid = {status:'error',code:'invalid_response'};
  if (!HASH.test(expectedTenantHash ?? '') || !exactKeys(value,['status','token','snapshot']) ||
      value.status !== 'ok' || typeof value.token !== 'string' || !TOKEN.test(value.token)) return invalid;
  const s = value.snapshot;
  if (!exactKeys(s,['status','origin','dashboard','domain','metric','licenseCode','licenseType','controlPointCode',
    'labelDomain','capacity','used','licenseState','scopeVerified','tenantKey','unfiltered','complete','observedAt','records']) ||
      s.tenantKey !== expectedTenantHash || !Number.isSafeInteger(s.observedAt) ||
      !Array.isArray(s.records) || s.records.some(row => !exactKeys(row,['id']) || typeof row.id !== 'string' || !HASH.test(row.id))) return invalid;
  try { validate(s,now); } catch { return invalid; }
  return {status:'ok',token:value.token,snapshot:structuredClone(s)};
}
