// Fixed, temporary read-only discovery. No rows, IDs, headers or cookies leave the page.
async function discover(kind) {
  if (location.origin !== 'https://c3.yonyoucloud.com') return { status: 'needs_login' };
  const bootstrap = kind === 'bootstrap';
  const url = bootstrap
    ? 'https://c3.yonyoucloud.com/mdf-node/mdf/resource?isDiwork=true&isMobile=false'
    : 'https://c3.yonyoucloud.com/iuap-apcom-auth/u8c-auth/bill/list?serviceCode=GZTSYS035&appCode=BIP0002YB&terminalType=1&fromYonyou=true';
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10000);
  try {
    const options = { method: bootstrap ? 'GET' : 'POST', credentials: 'same-origin',
      cache: 'no-store', redirect: 'error', signal: abort.signal,
      headers: { Accept: bootstrap ? '*/*' : 'application/json', isAjax: '1' } };
    if (!bootstrap) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify({ billnum: 'sys_user_licenselist', ownDomain: 'u8c-auth',
        serviceCode: 'GZTSYS035', appCode: 'BIP0002YB', page: { pageIndex: 1, pageSize: 20 },
        condition: { bInit: true, commonVOs: [
          { itemName: 'schemeName', value1: '默认方案' }, { itemName: 'isDefault', value1: true },
        ] }, bEmptyWithoutFilterTree: true });
    }
    const response = await fetch(url, options);
    if (response.status === 401) return { status: 'needs_login' };
    if (response.status === 403) return { status: 'access_denied' };
    const contentType = response.headers.get('content-type')?.split(';')[0] ?? '';
    const text = await response.text();
    if (text.length > 2000000) return { status: 'error', code: 'invalid_response' };
    if (bootstrap) {
      const urls = new Set();
      for (const match of text.matchAll(/(?:https?:)?\/\/[^\s"'<>]+\.js(?:\?[^\s"'<>]*)?/g)) {
        try {
          const u = new URL(match[0], response.url);
          if (u.protocol === 'https:' && !u.username && !u.password &&
              ['c3.yonyoucloud.com', 'static-dc-core3.yonyoucloud.com'].includes(u.hostname) && !u.search) urls.add(u.href);
        } catch {}
      }
      return { status: 'diagnostic', diagnostic: { httpStatus: response.status, contentType,
        byteLength: text.length, scriptUrls: [...urls].slice(0, 100),
        scriptLiterals: [...text.matchAll(/["']([^"'\s\\]*\.js)["']/g)].map(x => x[1]).filter(x=>x.length<500&&!x.includes('?')).slice(0,100),
        assetBases: [...text.matchAll(/https?:\/\/(?:static-dc-core3|c3)\.yonyoucloud\.com[^"'\s<>\\]*/g)].map(x=>x[0]).filter(x=>!x.includes('?')&&!x.includes('#')).slice(0,30),
      } };
    }
    let data;
    try { data = JSON.parse(text); } catch { return { status: 'error', code: 'invalid_response' }; }
    const arrays = [], objects = [];
    const walk = (v, path, depth) => {
      if (depth > 3 || v === null || typeof v !== 'object') return;
      if (Array.isArray(v)) {
        const rows = v.filter(x => x && typeof x === 'object' && !Array.isArray(x));
        const ids = rows.map(x => x.userId).filter(x => typeof x === 'string' && x.length);
        arrays.push({ path, length: v.length, keys: rows[0] ? Object.keys(rows[0]).slice(0, 80) : [],
          userIdCount: ids.length, uniqueUserIdCount: new Set(ids).size });
        return;
      }
      const counts = {};
      for (const key of ['recordCount','totalCount', 'pageCount', 'pageIndex', 'pageSize']) {
        if (Number.isSafeInteger(v[key])) counts[key] = v[key];
        else if (typeof v[key] === 'string' && /^\d+$/.test(v[key]) && Number.isSafeInteger(Number(v[key]))) counts[key] = Number(v[key]);
      }
      objects.push({ path, keys: Object.keys(v).slice(0, 80), ...counts });
      for (const key of ['data', 'result', 'page', 'recordList', 'list', 'rows', 'records', 'content']) if (Object.hasOwn(v, key)) walk(v[key], path + '.' + key, depth + 1);
    };
    walk(data, 'root', 0);
    return { status: 'diagnostic', diagnostic: { httpStatus: response.status, contentType,
      bodyStatus: typeof data.status === 'number' ? data.status : null,
      bodyCode: typeof data.code === 'number' ? data.code : null, objects, arrays } };
  } catch { return { status: 'error', code: abort.signal.aborted ? 'timeout' : 'transport_error' }; }
  finally { clearTimeout(timer); }
}

export function buildDiscoveryEvaluation(kind) {
  if (!['bootstrap', 'detail'].includes(kind)) throw new TypeError('invalid discovery kind');
  return '(' + discover.toString() + ')(' + JSON.stringify(kind) + ')';
}
