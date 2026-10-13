const ERROR_CODES = new Set([
  'unknown', 'wrong_tenant', 'invalid_response', 'timeout', 'transport_error',
]);

// No request input is interpolated into this script. Raw enterprise identifiers
// are compared and hashed inside the browser and never returned to Node.
export function buildTenantScopeEvaluation() {
  return `(async () => {
    if (location.origin !== 'https://c3.yonyoucloud.com') return { status: 'needs_login' };
    const meUrl = 'https://c3.yonyoucloud.com/iuap-apcom-workbench/me?onlyShayat=false';
    const userUrl = 'https://c3.yonyoucloud.com/iuap-apcom-workbench/user/getUserInfo?userId=';
    const abort = new AbortController();
    let expired = false;
    let timer;
    const fail = code => { throw { scopeCode: code }; };
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const identifier = value => typeof value === 'string' && value.trim().length > 0;
    const read = async url => {
      let response;
      try {
        response = await fetch(url, {
          method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          headers: { Accept: 'application/json', isAjax: '1' }, signal: abort.signal,
        });
      } catch { fail(expired ? 'timeout' : 'transport_error'); }
      if (response.status === 401) fail('needs_login');
      if (response.status === 403) fail('access_denied');
      if (response.status !== 200 || response.url !== url || response.redirected !== false ||
          response.type === 'opaqueredirect') fail('invalid_response');
      const mediaType = response.headers?.get?.('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (!mediaType || !/^application\\/(?:[a-z0-9!#$&^_.+-]+\\+)?json$/.test(mediaType)) {
        fail('invalid_response');
      }
      let body;
      try { body = await response.json(); } catch { fail(expired ? 'timeout' : 'invalid_response'); }
      if (body?.needrelogin === true || body?.errorCode === '000001') fail('needs_login');
      if (!record(body) || body.status !== 1 || !record(body.data)) fail('invalid_response');
      return body.data;
    };
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject({ scopeCode: 'timeout' });
        abort.abort();
      }, 10000);
    });
    try {
      return await Promise.race([deadline, (async () => {
        const before = await read(meUrl);
        const firstId = before.tenantid;
        if (!identifier(firstId)) fail('invalid_response');
        const user = await read(userUrl);
        const userId = record(user.currentTeamConfig) ? user.currentTeamConfig.tenantId : undefined;
        const company = user.company;
        if (!identifier(userId) || typeof company !== 'string' ||
            company.trim().length === 0 || company.length > 160) fail('invalid_response');
        const after = await read(meUrl);
        const lastId = after.tenantid;
        if (!identifier(lastId)) fail('invalid_response');
        if (firstId !== userId || firstId !== lastId) fail('wrong_tenant');
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(firstId));
        const tenantHash = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
        return { status: 'ok', scope: { tenantHash, company, observedAt: Date.now() } };
      })()]);
    } catch (error) {
      const code = error?.scopeCode;
      if (code === 'needs_login' || code === 'access_denied') return { status: code };
      const known = ['wrong_tenant', 'invalid_response', 'timeout', 'transport_error'];
      return { status: 'error', code: known.includes(code) ? code : 'unknown' };
    } finally { clearTimeout(timer); }
  })()`;
}

export function sanitizeTenantScope(value) {
  if (value?.status === 'needs_login' || value?.status === 'access_denied') {
    return { status: value.status };
  }
  if (value?.status === 'ok') {
    const scope = value.scope;
    if (typeof scope?.tenantHash === 'string' && /^[a-f0-9]{64}$/.test(scope.tenantHash) &&
        typeof scope.company === 'string' && scope.company.trim().length > 0 && scope.company.length <= 160 &&
        Number.isSafeInteger(scope.observedAt) && scope.observedAt >= 0) {
      return { status: 'ok', scope: {
        tenantHash: scope.tenantHash, company: scope.company, observedAt: scope.observedAt,
      } };
    }
    return { status: 'error', code: 'invalid_response' };
  }
  return { status: 'error', code: ERROR_CODES.has(value?.code) ? value.code : 'unknown' };
}
