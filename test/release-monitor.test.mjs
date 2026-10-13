import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, chmod, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TARGET } from '../src/policy.mjs';
import { createReleaseMonitor, createReleaseStatusWriter, RELEASE_INTERVAL_MS } from '../src/release-monitor.mjs';

const at = 1_800_000_000_000;
const snapshot = (used = 10) => ({
  ...TARGET, status: 'ok', tenantKey: 'synthetic-tenant', scopeVerified: true,
  unfiltered: true, complete: true, observedAt: at, licenseState: 'active', used,
  records: Array.from({ length: used }, (_, index) => ({ id: `synthetic-person-${index}` })),
});
function setup({ reads = [snapshot(9)], enabled = true, release, writeStatus, initial, read } = {}) {
  let stored = initial;
  let readCalls = 0;
  let releaseCalls = 0;
  let interval;
  let cleared = false;
  const states = [];
  const logs = [];
  const journal = { read: async () => stored, write: async value => { stored = structuredClone(value); } };
  const adapter = {
    read: async () => { readCalls++; return read ? read() : reads.shift(); },
    release: async operation => { releaseCalls++; return release ? release(operation) : { status: 'acknowledged' }; },
  };
  const options = {
    adapter, journal, enabled, now: () => at,
    writeStatus: writeStatus ?? (async value => { states.push(structuredClone(value)); }),
    log: value => logs.push(value),
    setEvery: (callback, duration) => { assert.equal(duration, RELEASE_INTERVAL_MS); interval = callback; return 1; },
    clearEvery: () => { cleared = true; },
  };
  const monitor = createReleaseMonitor(options);
  return { monitor, options, journal, states, logs, fire: () => interval?.(),
    get reads() { return readCalls; }, get writes() { return releaseCalls; }, get cleared() { return cleared; } };
}

test('enabled must be explicitly boolean; preview cannot release and 9/10 only observes', async () => {
  assert.throws(() => createReleaseMonitor(), /enabled/);
  assert.throws(() => createReleaseMonitor({ enabled: 'true' }), /enabled/);
  const observing = setup();
  assert.equal((await observing.monitor.tick()).status, 'observing');
  assert.equal(observing.writes, 0);
  const preview = setup({ reads: [snapshot()], enabled: false });
  assert.equal((await preview.monitor.tick()).status, 'preview');
  assert.equal(preview.writes, 0);
});

test('a full verified cycle releases once and persists only safe public fields', async () => {
  const after = snapshot(2);
  after.records = [{ id: 'synthetic-new-person-a' }, { id: 'synthetic-new-person-b' }];
  const run = setup({ reads: [snapshot(), snapshot(), after] });
  const state = await run.monitor.tick();
  assert.equal(state.status, 'released');
  assert.equal(state.before, 10);
  assert.equal(state.after, 2);
  assert.equal(run.writes, 1);
  assert.equal((await run.journal.read()).status, 'verified');
  assert.doesNotMatch(JSON.stringify([run.states, run.logs]), /synthetic-person|synthetic-tenant|fingerprint|operationId/);
});

test('an uncertain release leaves pending, pauses all future ticks and stays idle until stopped', async () => {
  const run = setup({ reads: [snapshot(), snapshot()], release: async () => { throw new Error('secret response'); } });
  const state = await run.monitor.start();
  assert.equal(state.status, 'paused');
  assert.equal(state.reason, 'needs_reconciliation');
  assert.equal((await run.journal.read()).status, 'pending');
  assert.equal(run.cleared, false);
  run.fire(); run.fire(); await run.monitor.tick();
  assert.equal(run.reads, 2);
  assert.equal(run.writes, 1);
  const restarted = createReleaseMonitor({ ...run.options, journal: run.journal });
  assert.equal((await restarted.tick()).reason, 'needs_reconciliation');
  assert.equal(run.writes, 1);
  await run.monitor.stop();
  assert.equal(run.cleared, true);
});

test('login, access, scope and unknown failures pause without counts or automatic retries', async () => {
  for (const [code, expected] of [['needs_login', 'needs_login'], ['access_denied', 'access_denied'],
    ['wrong_tenant', 'scope_mismatch'], ['wrong_target', 'scope_mismatch'], ['secret-code', 'unexpected_error']]) {
    const run = setup({ read: async () => { throw Object.assign(new Error('Cookie: synthetic-secret'), { code }); } });
    const state = await run.monitor.start();
    assert.equal(state.reason, expected);
    assert.equal(state.used, undefined);
    run.fire(); await run.monitor.tick();
    assert.equal(run.reads, 1);
    assert.equal(run.writes, 0);
    assert.doesNotMatch(JSON.stringify([run.states, run.logs]), /Cookie|synthetic-secret|secret-code/);
    await run.monitor.stop();
  }
});

test('known read race retries next cycle before pending, while release-stage races stay paused', async () => {
  for (const failingRead of [1, 2]) {
    let reads = 0;
    const run = setup({ read: async () => {
      reads++;
      if (reads === failingRead) throw Object.assign(new Error('snapshot changed'), { code: 'snapshot_changed' });
      return snapshot(reads < failingRead ? 10 : 9);
    } });
    assert.equal((await run.monitor.start()).status, 'changed_retry_next_cycle');
    assert.equal(await run.journal.read(), undefined);
    assert.equal(run.writes, 0);
    assert.equal(run.cleared, false);
    run.fire();
    assert.equal((await run.monitor.tick()).status, 'observing');
    assert.equal(run.reads, failingRead + 1);
    assert.equal(run.writes, 0);
    await run.monitor.stop();
  }
  const pending = setup({ reads: [snapshot(), snapshot()], release: async () => {
    throw Object.assign(new Error('snapshot changed'), { code: 'snapshot_changed' });
  } });
  assert.equal((await pending.monitor.start()).reason, 'needs_reconciliation');
  assert.equal((await pending.journal.read()).status, 'pending');
  pending.fire(); await pending.monitor.tick();
  assert.equal(pending.reads, 2);
  assert.equal(pending.writes, 1);
  await pending.monitor.stop();
});

test('status write failure stops before any adapter read or release', async () => {
  const run = setup({ writeStatus: async () => { throw new Error('private path'); } });
  const state = await run.monitor.start();
  assert.equal(state.reason, 'status_write_failed');
  run.fire(); await run.monitor.tick();
  assert.equal(run.reads, 0);
  assert.equal(run.writes, 0);
  assert.equal(run.cleared, false);
  await run.monitor.stop();
});

test('60-second scheduling and manual ticks share a single in-flight Controller call', async () => {
  let finish;
  const run = setup({ read: () => new Promise(resolve => { finish = resolve; }) });
  const first = run.monitor.start();
  await new Promise(resolve => setImmediate(resolve));
  run.fire();
  assert.equal(run.monitor.tick(), first);
  assert.equal(run.reads, 1);
  finish(snapshot(9));
  assert.equal((await first).status, 'observing');
  await run.monitor.stop();
  assert.equal(run.cleared, true);
});

test('stop during a read prevents a later full result from starting a release', async () => {
  let finish;
  const run = setup({ read: () => new Promise(resolve => { finish = resolve; }) });
  const active = run.monitor.start();
  await new Promise(resolve => setImmediate(resolve));
  const stopped = run.monitor.stop();
  finish(snapshot());
  await active;
  assert.equal((await stopped).status, 'stopped');
  assert.equal(run.writes, 0);
});

test('stop while pending is being persisted leaves reconciliation state without sending release', async () => {
  let finish;
  const run = setup({ reads: [snapshot(), snapshot()] });
  const originalWrite = run.journal.write;
  run.journal.write = async value => { await new Promise(resolve => { finish = resolve; }); await originalWrite(value); };
  const active = run.monitor.start();
  await new Promise(resolve => setImmediate(resolve));
  const stopped = run.monitor.stop();
  finish();
  await active;
  assert.equal((await stopped).reason, 'needs_reconciliation');
  assert.equal(run.writes, 0);
  assert.equal((await run.journal.read()).status, 'pending');
});

test('safe status writer uses a private file and rejects credential fields before writing', async t => {
  const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), 'yon-release-status-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const write = createReleaseStatusWriter({ directory });
  const safe = { status: 'paused', reason: 'needs_login', enabled: true, checkedAt: at, cycle: 1 };
  await write(safe);
  const file = path.join(directory, 'status.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.throws(() => write({ ...safe, cookie: 'synthetic-secret' }), /Invalid release status/);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), safe);
});
