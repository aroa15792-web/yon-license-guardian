// Observed on the procurement licence dashboard on 2026-10-13. This internal
// endpoint is not a confirmed public OpenAPI or a tenant-scoped release adapter.
export const SUMMARY_URL = 'https://c3.yonyoucloud.com/iuap-apcom-workbench/manager/license/getTenantLicenseInfo?labelDomain=MM&status=VALID';

const SOURCE = Object.freeze({
  method: 'GET', url: SUMMARY_URL,
  licenseCode: 'BIP0002YB', licenseType: 'SHAREUSER',
  controlPointCode: 'BIPSCM0201', labelDomain: 'MM',
});

const messages = Object.freeze({
  invalid_response: '许可统计响应格式无效，人数未知',
  wrong_target: '响应未唯一对应指定采购许可，人数未知',
  invalid_count: '许可容量或占用人数无效，人数未知',
  http_error: '许可统计请求未成功，人数未知',
  redirect: '许可统计请求发生重定向或来源变化，人数未知',
  timeout: '许可统计读取超时，人数未知',
  transport_error: '许可统计连接失败，人数未知',
});

export class LicenseSummaryError extends Error {
  constructor(code) {
    super(messages[code]);
    this.name = 'LicenseSummaryError';
    this.code = code;
  }
}

const fail = code => { throw new LicenseSummaryError(code); };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Parse only the summary; this cannot establish tenant identity or a full list. */
export function parseLicenseSummary(payload) {
  if (!isRecord(payload) || payload.status !== 1 || !Array.isArray(payload.data) ||
      payload.data.some(item => !isRecord(item))) fail('invalid_response');

  const groups = payload.data.filter(item => item.code === SOURCE.licenseCode);
  if (groups.length !== 1) fail('wrong_target');
  const group = groups[0];
  if (group.type !== SOURCE.licenseType || group.name !== '专业应用用户数' ||
      !Array.isArray(group.controlPoints) || group.controlPoints.length !== 1) fail('wrong_target');
  const point = group.controlPoints[0];
  if (!isRecord(point) || point.code !== SOURCE.controlPointCode ||
      point.labelDomain !== SOURCE.labelDomain || point.status !== 'VALID' ||
      point.relyUserMaterial !== SOURCE.licenseCode) fail('wrong_target');

  // A target control point appearing under another group is ambiguous too.
  if (payload.data.some(item => item !== group && Array.isArray(item.controlPoints) &&
      item.controlPoints.some(other => other?.code === SOURCE.controlPointCode))) fail('wrong_target');
  if (group.amount !== 10 || !Number.isSafeInteger(group.usedAmount) || group.usedAmount < 0) {
    fail('invalid_count');
  }
  return Object.freeze({
    kind: 'procurement-license-summary', source: SOURCE,
    capacity: group.amount, used: group.usedAmount, full: group.usedAmount >= group.amount,
  });
}

/**
 * transport(url, options) must provide a Fetch-compatible Response and enforce
 * options.redirect === 'error' BEFORE forwarding credentials, and AbortSignal.
 * Its authenticated context is supplied by the caller, never read from disk here.
 * No arbitrary URL, request headers, request body or write operation is accepted.
 * A successful result is not compatible with Controller.adapter.read().
 */
export function createLicenseSummaryClient({ transport, timeoutMs = 10_000, now = Date.now } = {}) {
  if (typeof transport !== 'function') throw new TypeError('必须注入只读 transport');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new TypeError('timeoutMs 必须为 1 至 60000 的整数');
  }
  if (typeof now !== 'function') throw new TypeError('now 必须为函数');

  return Object.freeze({
    async read() {
      const abort = new AbortController();
      let timer;
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new LicenseSummaryError('timeout'));
          abort.abort();
        }, timeoutMs);
      });
      const request = (async () => {
        const response = await transport(SUMMARY_URL, Object.freeze({
          method: 'GET', redirect: 'error', cache: 'no-store', signal: abort.signal,
        }));
        if (!response || response.redirected !== false || response.url !== SUMMARY_URL ||
            response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
          fail('redirect');
        }
        if (response.status !== 200) fail('http_error');
        const mediaType = response.headers?.get?.('content-type')?.split(';', 1)[0].trim().toLowerCase();
        if (!mediaType || !/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json$/.test(mediaType) ||
            typeof response.json !== 'function') fail('invalid_response');
        let payload;
        try { payload = await response.json(); } catch { fail('invalid_response'); }
        const result = parseLicenseSummary(payload);
        const observedAt = now();
        if (!Number.isSafeInteger(observedAt) || observedAt < 0) fail('invalid_response');
        return Object.freeze({ ...result, observedAt });
      })();
      try {
        return await Promise.race([request, expired]);
      } catch (error) {
        // Do not attach causes, raw responses, URLs from redirects or auth headers.
        if (error instanceof LicenseSummaryError && Object.hasOwn(messages, error.code)) {
          throw new LicenseSummaryError(error.code);
        }
        throw new LicenseSummaryError('transport_error');
      } finally {
        clearTimeout(timer);
      }
    },
  });
}
