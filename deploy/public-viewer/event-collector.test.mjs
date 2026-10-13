import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { createEventCollector } from './event-collector.mjs';
import { createEventStore } from './event-store.mjs';
import { STALE_AFTER_MS } from './event-contract.mjs';

const initial = 2_000_000_000_000;
const observation = at => ({ monitor: { status: 'observing', checkedAt: at, enabled: true, capacity: 10, used: 2 }, test: null });
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yon-collector-')); await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = initial;
  let value = observation(now);
  let failure = false;
  let reads = 0;
  const clock = () => now;
  const store = await createEventStore({ directory, now: clock });
  const options = { store, now: clock, readStatus: async () => { reads++; if (failure) throw new Error('synthetic-private-error'); return value; } };
  const collector = createEventCollector(options);
  t.after(() => collector.close());
  return { directory, store, collector, options, clock, advance(ms) { now += ms; }, at() { return now; },
    set(next) { value = next; }, fail(flag) { failure = flag; }, reads() { return reads; } };
}

test('identical results deduplicate, while each new original checkedAt records one observation', async t => {
  const f = await fixture(t);
  await f.collector.tick(); f.advance(15_000); await f.collector.tick();
  assert.equal((await f.store.list()).events.length, 1);
  f.set(observation(f.at())); await f.collector.tick();
  assert.equal((await f.store.list()).events.length, 2);
  assert.deepEqual((await f.store.list()).events.map(event => event.at), [initial + 15_000, initial]);
  assert.equal((await f.store.list()).lastObservedAt, initial + 15_000);
  f.set(observation(initial)); await f.collector.tick();
  assert.equal((await f.store.list()).events.length, 2, 'outdated observations are not replayed');
});

test('connection failure and recovery, unavailable status and freshness emit only transitions', async t => {
  const f = await fixture(t);
  await f.collector.tick();
  f.fail(true); f.advance(15_000); await f.collector.tick(); f.advance(15_000); await f.collector.tick();
  f.fail(false); f.advance(15_000); await f.collector.tick(); await f.collector.tick();
  f.set({ monitor: { status: 'unavailable' }, test: null }); await f.collector.tick(); await f.collector.tick();
  f.set(observation(f.at())); await f.collector.tick();
  f.advance(STALE_AFTER_MS + 1); await f.collector.tick(); await f.collector.tick();
  f.set(observation(f.at())); await f.collector.tick();
  const events = (await f.store.list()).events;
  for (const type of ['connection_unavailable', 'connection_restored', 'status_unavailable', 'status_available', 'status_stale', 'status_fresh']) {
    assert.equal(events.filter(event => event.type === type).length, 1, type);
  }
  const failure = events.find(event => event.type === 'connection_unavailable');
  assert.equal(Object.hasOwn(failure, 'used'), false);
  assert.doesNotMatch(JSON.stringify(events), /synthetic-private|captcha|reason|cookie/);
});

test('release, pause and separate verified test preserve permitted counts and original timestamps', async t => {
  const f = await fixture(t);
  const releaseAt = initial - 1000;
  const testAt = initial - 2000;
  f.set({ monitor: { status: 'released', enabled: true, checkedAt: releaseAt, capacity: 10, before: 10, after: 0, released: 10 },
    test: { status: 'verified', checkedAt: testAt, before: 8, after: 0, released: 8 } });
  await f.collector.tick(); await f.collector.tick();
  f.advance(15_000); f.set({ monitor: { status: 'paused', enabled: true, checkedAt: f.at() }, test: null });
  await f.collector.tick();
  const events = (await f.store.list()).events;
  assert.equal(events.length, 3);
  assert.equal(events.find(event => event.type === 'monitor_released').at, releaseAt);
  assert.equal(events.find(event => event.type === 'test_verified').at, testAt);
  assert.equal(events.find(event => event.type === 'test_verified').source, 'test');
  const paused = events.find(event => event.type === 'monitor_paused');
  assert.deepEqual(Object.keys(paused), ['id', 'at', 'type', 'level', 'source', 'status']);
  assert.equal(paused.level, 'warn');
});

test('restart preserves deduplication and neither fabricates history nor repeats an ongoing connection failure', async t => {
  const f = await fixture(t);
  await f.collector.tick(); f.fail(true); f.advance(15_000); await f.collector.tick();
  const before = await f.store.list(); await f.collector.close();
  const reopened = await createEventStore({ directory: f.directory, now: f.clock });
  const restarted = createEventCollector({ ...f.options, store: reopened });
  t.after(() => restarted.close());
  await restarted.tick();
  assert.deepEqual(await reopened.list(), before);
  f.fail(false); await restarted.tick();
  assert.equal((await reopened.list()).events.length, before.events.length + 1);
});

test('invalid upstream fields fail closed as collection unavailability without persisting private scalars', async t => {
  const f = await fixture(t);
  f.set({ ...observation(initial), cookie: 'synthetic-private-cookie' });
  await f.collector.tick();
  const value = await f.store.list();
  assert.deepEqual(value.events.map(event => event.type), ['connection_unavailable']);
  assert.equal(value.lastObservedAt, null);
  assert.doesNotMatch(JSON.stringify(value), /synthetic-private|used|capacity|cookie/);
});

test('background polling runs without page requests and overlapping ticks share one read', async t => {
  const f = await fixture(t);
  let active = 0; let peak = 0; let reads = 0;
  const collector = createEventCollector({ store: f.store, now: f.clock, intervalMs: 10,
    readStatus: async () => { active++; peak = Math.max(active, peak); reads++;
      await new Promise(resolve => setTimeout(resolve, 10)); active--; return observation(f.at()); } });
  t.after(() => collector.close());
  collector.start(); await Promise.all([collector.tick(), collector.tick()]);
  await new Promise(resolve => setTimeout(resolve, 70)); await collector.close();
  assert.ok(reads >= 3);
  assert.equal(peak, 1);
  assert.equal((await f.store.list()).events.length, 1);
});
