import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/controller.mjs';
import { TARGET, fingerprint, plan } from '../src/policy.mjs';

const now = 1_800_000_000_000;
// Synthetic test fixture only; real adapters must read every target field from
// the matched dashboard/list rather than fill missing fields from TARGET.
const snapshot = (used = 10, overrides = {}) => ({
  ...TARGET, status: 'ok', tenantKey: 'synthetic-test-tenant', scopeVerified: true,
  unfiltered: true, complete: true, observedAt: now, licenseState: 'active', used,
  records: Array.from({ length: used }, (_, i) => ({ id: `test-${i}` })), ...overrides,
});
function setup(reads, { enabled = true, release, initial } = {}) {
  let data = initial;
  let writes = 0;
  const journal = { read: async () => data, write: async v => { data = v; } };
  const adapter = {
    read: async () => {
      if (!reads.length) throw new Error('No further observation supplied');
      return reads.shift();
    },
    release: async operation => { writes++; return release ? release(operation) : { status: 'acknowledged' }; },
  };
  return { controller: new Controller({ adapter, journal, enabled, now: () => now }),
    journal, adapter, get writes() { return writes; } };
}

test('9 people wait; 10 and 11 propose release', () => {
  assert.equal(plan(snapshot(9), now).action, 'wait');
  assert.equal(plan(snapshot(), now).count, 10);
  assert.equal(plan(snapshot(11), now).count, 11);
});
for (const [field, incorrect] of Object.entries({
  licenseCode: 'BIP0002XX',
  licenseType: 'USER',
  controlPointCode: 'BIPSCM9999',
  labelDomain: 'FI',
})) {
  for (const value of [incorrect, undefined]) {
    test(`refuses ${value === undefined ? 'missing' : 'wrong'} ${field} despite matching labels and capacity`, async () => {
      const observation = snapshot(10, { [field]: value });
      if (value === undefined) delete observation[field];
      const run = setup([observation]);
      await assert.rejects(() => run.controller.tick(), new RegExp(field));
      assert.equal(run.writes, 0);
    });
  }
}
test('target fields inherited from defaults are not observed snapshot fields', () => {
  const observation = snapshot();
  delete observation.licenseCode;
  Object.setPrototypeOf(observation, TARGET);
  assert.throws(() => plan(observation, now), /licenseCode/);
});
test('fingerprint binds all target fields and tenant while ignoring record order', () => {
  const before = snapshot();
  const original = fingerprint(before);
  for (const field of Object.keys(TARGET)) {
    assert.notEqual(fingerprint({ ...before, [field]: `different-${field}` }), original, field);
  }
  assert.notEqual(fingerprint({ ...before, tenantKey: 'different-test-tenant' }), original);
  assert.equal(fingerprint({ ...before, records: [...before.records].reverse() }), original);
});
for (const [reason, overrides] of Object.entries({
  'failed fetch represented as empty': { status: 'network_error', used: 0, records: [] },
  'wrong cloud': { domain: '财务云' },
  'wrong origin': { origin: 'https://example.test' },
  'scope not established': { scopeVerified: false },
  'string instead of verified boolean': { scopeVerified: 'false' },
  'filters applied': { unfiltered: false },
  'missing pages': { complete: false },
  'stale data': { observedAt: now - 30_001 },
  'future timestamp': { observedAt: now + 1 },
  'mismatched count': { used: 9 },
  'expired license': { licenseState: 'expired' },
  'capacity changed': { capacity: 20 },
  'duplicate records': { records: Array(10).fill({ id: 'same' }) },
})) {
  test(`refuses ${reason}`, async () => {
    const run = setup([snapshot(10, overrides)]);
    await assert.rejects(() => run.controller.tick());
    assert.equal(run.writes, 0);
  });
}
test('preview mode never writes to the service', async () => {
  const run = setup([snapshot()], { enabled: false });
  assert.equal((await run.controller.tick()).status, 'preview');
  assert.equal(run.writes, 0);
});
test('successful release requires a fresh empty list and matching scope', async () => {
  const run = setup([snapshot(), snapshot(), snapshot(0)]);
  assert.equal((await run.controller.tick()).status, 'verified');
  assert.equal(run.writes, 1);
  assert.equal((await run.journal.read()).status, 'verified');
});
test('membership changed between reads: no release', async () => {
  const next = snapshot(); next.records[9].id = 'new-person';
  const run = setup([snapshot(), next]);
  assert.equal((await run.controller.tick()).status, 'changed_retry_next_cycle');
  assert.equal(run.writes, 0);
});
test('a different licence with the same labels on re-read cannot be released', async () => {
  const run = setup([snapshot(), snapshot(10, { licenseCode: 'BIP0002XX' })]);
  await assert.rejects(() => run.controller.tick(), /licenseCode/);
  assert.equal(run.writes, 0);
});
test('lost release response remains pending across a controller restart', async () => {
  const run = setup([snapshot(), snapshot()], { release: async () => { throw new Error('connection closed'); } });
  assert.equal((await run.controller.tick()).status, 'needs_reconciliation');
  const restarted = new Controller({ adapter: run.adapter, journal: run.journal, enabled: true, now: () => now });
  assert.equal((await restarted.tick()).status, 'needs_reconciliation');
  assert.equal(run.writes, 1);
});
test('unchanged list after click is not successful', async () => {
  const run = setup([snapshot(), snapshot(), snapshot()]);
  assert.equal((await run.controller.tick()).status, 'needs_reconciliation');
  assert.equal((await run.journal.read()).status, 'pending');
});
test('empty data from a different tenant does not prove release', async () => {
  const run = setup([snapshot(), snapshot(), snapshot(0, { tenantKey: 'different-test-tenant' })]);
  assert.equal((await run.controller.tick()).status, 'needs_reconciliation');
});
test('empty data for a different control point does not prove release', async () => {
  const run = setup([snapshot(), snapshot(), snapshot(0, { controlPointCode: 'BIPSCM9999' })]);
  assert.equal((await run.controller.tick()).status, 'needs_reconciliation');
  assert.equal((await run.journal.read()).status, 'pending');
});
test('network failure during verification is not treated as zero', async () => {
  const run = setup([snapshot(), snapshot(), snapshot(0, { status: 'network_error' })]);
  assert.equal((await run.controller.tick()).status, 'needs_reconciliation');
});
test('concurrent invocations do not double-submit', async () => {
  let finish;
  const run = setup([snapshot(), snapshot(), snapshot(0)], {
    release: () => new Promise(resolve => { finish = resolve; }),
  });
  const first = run.controller.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await run.controller.tick()).status, 'busy');
  finish({ status: 'acknowledged' });
  assert.equal((await first).status, 'verified');
  assert.equal(run.writes, 1);
});
test('recent successful operation observes cooldown', async () => {
  const run = setup([snapshot()], { initial: { status: 'verified', at: now - 1000 } });
  assert.equal((await run.controller.tick()).status, 'cooldown');
  assert.equal(run.writes, 0);
});
test('failed durable journal write prevents the remote release', async () => {
  const run = setup([snapshot(), snapshot()]);
  run.journal.write = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(() => run.controller.tick());
  assert.equal(run.writes, 0);
});
test('a string false cannot enable real operations', () => {
  assert.throws(() => setup([], { enabled: 'false' }), TypeError);
});
