import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, lstat, readFile, mkdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  createSummaryMonitor, createUnixSummaryReader, createStatusWriter,
  validateResponse, MonitorError, INTERVAL_MS, REQUEST_TIMEOUT_MS, MAX_RESPONSE_BYTES, SOCKET_PATH,
} from '../src/summary-monitor.mjs';

const time = 1_800_000_000_000;
const ok = (used = 5, observedAt = time) => ({ status: 'ok', summary: {
  kind: 'procurement-license-summary', capacity: 10, used, full: used >= 10, observedAt,
} });
const response = (value = ok(), statusCode = 200) => ({
  statusCode, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(value),
});
const socketStat = async path => ({
  uid: process.getuid(), mode: path === SOCKET_PATH ? 0o600 : 0o700,
  isDirectory: () => path !== SOCKET_PATH, isSocket: () => path === SOCKET_PATH, isSymbolicLink: () => false,
});

function harness(readSummary) {
  let clock = time;
  let scheduled;
  const writes = [];
  const logs = [];
  const intervals = [];
  const monitor = createSummaryMonitor({
    readSummary, now: () => clock,
    writeStatus: async value => { writes.push(structuredClone(value)); },
    log: value => logs.push(value),
    setEvery: (fn, ms) => { intervals.push(ms); scheduled = fn; return 7; },
    clearEvery: id => { assert.equal(id, 7); scheduled = undefined; },
  });
  return { monitor, writes, logs, intervals, advance: ms => { clock += ms; }, scheduled: () => scheduled };
}

test('two 60-second cycles publish fresh counts; full only requests release validation', async () => {
  let calls = 0;
  const h = harness(async () => ++calls === 1 ? ok(9) : ok(10, time + INTERVAL_MS));
  await h.monitor.start();
  h.advance(INTERVAL_MS);
  await h.monitor.tick();
  assert.deepEqual(h.intervals, [60_000]);
  assert.equal(calls, 2);
  assert.equal(h.writes[0].status, 'observing');
  assert.equal(h.writes[1].status, 'needs_release_validation');
  assert.equal(h.writes[1].used, 10);
  assert.equal(h.writes[1].cycle, 2);
  assert.equal(h.monitor.release, undefined);
  for (const entry of h.logs) assert.deepEqual(Object.keys(entry).sort(), ['capacity', 'checkedAt', 'cycle', 'full', 'sourceObservedAt', 'status', 'used']);
  await h.monitor.stop();
});

test('401 and 403 pause without further requests, including malformed auth responses', async () => {
  for (const reason of ['needs_login', 'access_denied']) {
    for (const malformed of [false, true]) {
      let calls = 0;
      const h = harness(async () => {
        calls++;
        if (malformed) throw new MonitorError('invalid_response', reason);
        return { status: reason };
      });
      await h.monitor.start();
      await h.monitor.tick();
      assert.equal(calls, 1);
      assert.equal(h.scheduled(), undefined);
      assert.equal(h.monitor.getState().status, 'paused');
      assert.equal(h.monitor.getState().reason, reason);
      assert.equal(Object.hasOwn(h.logs[0], 'used'), false);
    }
  }
});

test('wrong enterprise scope pauses permanently without releasing or reading again', async () => {
  let calls = 0;
  const h = harness(async () => { calls++; return validateResponse(response({ status: 'error', code: 'wrong_tenant' }, 502), time); });
  await h.monitor.start();
  await h.monitor.tick();
  assert.equal(h.monitor.getState().status, 'paused_scope_mismatch');
  assert.equal(calls, 1);
  assert.equal(h.scheduled(), undefined);
});

test('startup unavailable and later network failure do not become zero or stale current counts', async () => {
  let calls = 0;
  const h = harness(async () => {
    calls++;
    if (calls === 1) throw new MonitorError('unavailable');
    if (calls === 2) return ok(5, time + INTERVAL_MS);
    throw new Error('raw secret must never be logged');
  });
  await h.monitor.start();
  assert.equal(h.monitor.getState().status, 'unavailable');
  assert.ok(h.scheduled());
  h.advance(INTERVAL_MS); await h.monitor.tick();
  h.advance(INTERVAL_MS); await h.monitor.tick();
  const current = h.monitor.getState();
  assert.equal(current.status, 'unavailable');
  assert.equal(current.used, undefined);
  assert.equal(current.capacity, undefined);
  assert.deepEqual(current.lastSuccess, { used: 5, capacity: 10, full: false, checkedAt: time + INTERVAL_MS, sourceObservedAt: time + INTERVAL_MS });
  assert.equal(JSON.stringify(h.logs).includes('secret'), false);
  assert.equal(h.logs.at(-1).used, undefined);
  assert.equal(calls, 3);
  await h.monitor.stop();
});

test('pending ticks do not overlap and stopping aborts the active request and timer', async () => {
  let calls = 0;
  let signal;
  const h = harness(({ signal: s }) => new Promise((_resolve, reject) => {
    calls++; signal = s;
    s.addEventListener('abort', () => reject(new MonitorError('aborted')), { once: true });
  }));
  const first = h.monitor.start();
  assert.equal(h.monitor.tick(), first);
  h.scheduled()();
  assert.equal(calls, 1);
  await h.monitor.stop();
  assert.equal(signal.aborted, true);
  assert.equal(h.scheduled(), undefined);
  assert.equal(h.writes.length, 0);
  await h.monitor.tick();
  assert.equal(calls, 1);
});

test('status response contract rejects extras, redirects, wrong scope/count and stale/future timestamps', () => {
  for (const age of [0, 30_000]) assert.equal(validateResponse(response(ok(0, time - age)), time).summary.used, 0);
  const invalid = [
    response({ ...ok(), token: 'secret' }), response({ ...ok(), summary: { ...ok().summary, records: [] } }),
    response(ok(5, time + 1)), response(ok(5, time - 30_001)), response(ok('5')),
    response({ ...ok(), summary: { ...ok().summary, capacity: 20 } }),
    response({ ...ok(), summary: { ...ok().summary, kind: 'other' } }),
    response({ ...ok(), summary: { ...ok().summary, full: true } }),
    response(ok(), 302), response({ status: 'error', code: 'secret' }, 502),
    response({ status: 'needs_login', detail: 'secret' }, 401),
    { ...response(), headers: { 'content-type': 'text/html' } },
    { ...response(), body: '<html>login</html>' },
  ];
  for (const value of invalid) assert.throws(() => validateResponse(value, time), MonitorError);
  assert.equal(validateResponse(response({ status: 'needs_login' }, 401), time).status, 'needs_login');
  assert.equal(validateResponse(response({ status: 'access_denied' }, 403), time).status, 'access_denied');
  for (const [statusCode, code] of [[409, 'busy'], [504, 'timeout'], [502, 'unknown'], [502, 'wrong_tenant']]) {
    assert.equal(validateResponse(response({ status: 'error', code }, statusCode), time).code, code);
  }
});

function fakeTransport({ body = JSON.stringify(ok()), statusCode = 200, hang = false, length } = {}) {
  const requests = [];
  let requestObject;
  let responseObject;
  const request = (options, callback) => {
    requests.push(options);
    requestObject = new EventEmitter();
    requestObject.destroy = () => { requestObject.destroyed = true; };
    requestObject.end = () => queueMicrotask(() => {
      if (hang) return;
      responseObject = new EventEmitter();
      responseObject.destroy = () => { responseObject.destroyed = true; };
      responseObject.statusCode = statusCode;
      responseObject.headers = { 'content-type': 'application/json', ...(length === undefined ? {} : { 'content-length': length }) };
      callback(responseObject);
      responseObject.emit('data', Buffer.from(body));
      responseObject.emit('end');
    });
    return requestObject;
  };
  return { request, requests, requestObject: () => requestObject, responseObject: () => responseObject };
}

test('Unix transport can only send fixed GET and enforces the 8 KiB inclusive body limit', async () => {
  const base = JSON.stringify(ok());
  const atLimit = fakeTransport({ body: base.padEnd(MAX_RESPONSE_BYTES, ' ') });
  const read = createUnixSummaryReader({ request: atLimit.request, stat: socketStat, now: () => time });
  assert.equal((await read()).summary.used, 5);
  assert.deepEqual(atLimit.requests[0], {
    socketPath: SOCKET_PATH, path: '/summary', method: 'GET', agent: false,
    headers: { Accept: 'application/json', Connection: 'close' }, maxHeaderSize: MAX_RESPONSE_BYTES,
  });
  for (const parameters of [
    { body: base.padEnd(MAX_RESPONSE_BYTES + 1, ' ') },
    { body: base, length: String(MAX_RESPONSE_BYTES + 1) },
  ]) {
    const transport = fakeTransport(parameters);
    await assert.rejects(createUnixSummaryReader({ request: transport.request, stat: socketStat, now: () => time })(), { code: 'response_too_large' });
    assert.equal(transport.requestObject().destroyed, true);
  }
});

test('Unix transport uses a total 20-second deadline and abort destroys its request', async () => {
  for (const abortInstead of [false, true]) {
    const transport = fakeTransport({ hang: true });
    let deadline;
    let cleared = false;
    const controller = new AbortController();
    const read = createUnixSummaryReader({
      request: transport.request, stat: socketStat, now: () => time,
      setTimer: (fn, ms) => { assert.equal(ms, REQUEST_TIMEOUT_MS); deadline = fn; return 8; },
      clearTimer: id => { assert.equal(id, 8); cleared = true; },
    });
    const promise = read({ signal: controller.signal });
    while (!deadline) await Promise.resolve();
    if (abortInstead) controller.abort(); else deadline();
    await assert.rejects(promise, { code: abortInstead ? 'aborted' : 'timeout' });
    assert.equal(transport.requestObject().destroyed, true);
    assert.equal(cleared, true);
  }
});

test('missing socket is recoverable and unsafe socket ownership is rejected without a request', async () => {
  let requests = 0;
  const request = () => { requests++; };
  const missing = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  await assert.rejects(createUnixSummaryReader({ request, stat: missing })(), { code: 'unavailable' });
  await assert.rejects(createUnixSummaryReader({ request, stat: socketStat, uid: process.getuid() + 1 })(), { code: 'unsafe_socket' });
  assert.equal(requests, 0);
});

test('status writes atomically with private permissions and rejects symlinks/foreign uid', async t => {
  const root = await mkdtemp(`${tmpdir()}/yon-summary-test-`);
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = `${root}/monitor`;
  const write = createStatusWriter({ directory });
  await write({ status: 'observing', used: 5 });
  await write({ status: 'unavailable', lastSuccess: { used: 5, sourceObservedAt: time } });
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  assert.equal((await lstat(`${directory}/status.json`)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(`${directory}/status.json`, 'utf8')).status, 'unavailable');
  await assert.rejects(createStatusWriter({ directory, uid: process.getuid() + 1 })({}), { code: 'unsafe_status_directory' });
  const link = `${root}/link`;
  await symlink(directory, link);
  await assert.rejects(createStatusWriter({ directory: link })({}), { code: 'unsafe_status_directory' });
  const other = `${root}/other`;
  await mkdir(other);
  await symlink(`${directory}/status.json`, `${other}/status.json`);
  await assert.rejects(createStatusWriter({ directory: other })({}), { code: 'unsafe_status_file' });
});

test('failed status persistence pauses requests rather than silently continuing', async () => {
  let calls = 0;
  const monitor = createSummaryMonitor({
    readSummary: async () => { calls++; return ok(); }, writeStatus: async () => { throw new Error('private path'); },
    now: () => time, log: () => {},
  });
  await monitor.tick();
  await monitor.tick();
  assert.equal(monitor.getState().reason, 'status_write_failed');
  assert.equal(monitor.getState().used, undefined);
  assert.equal(calls, 1);
});
