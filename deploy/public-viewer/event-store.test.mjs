import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { chmod, lstat, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createEventStore, EVENT_FILE, MAX_EVENT_FILE_BYTES } from './event-store.mjs';
import { EVENT_PAGE_SIZE, RETENTION, publicEvents, validateDocument, validateEvent } from './event-contract.mjs';

const at = 2_000_000_000_000;
const fixture = async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'yon-events-'));
  await chmod(directory, 0o700);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, EVENT_FILE) };
};
const event = (index = 0, time = at) => ({ id: index.toString(16).padStart(32, '0'), at: time,
  type: 'monitor_status', level: 'info', source: 'monitor', status: 'observing', used: 2, capacity: 10 });

test('secure atomic store persists events, cursors, creation time and original event timestamps across restart', async t => {
  const f = await fixture(t);
  let now = at;
  const store = await createEventStore({ directory: f.directory, now: () => now });
  await store.update(document => { document.events.push(event(1, at - 1000)); document.lastObservedAt = at;
    document.cursors.monitor = { status: 'observing', enabled: true, checkedAt: at - 1000, used: 2, capacity: 10 }; });
  assert.equal((await lstat(f.file)).mode & 0o7777, 0o600);
  assert.equal((await lstat(f.directory)).mode & 0o7777, 0o700);
  const initial = await store.list();
  await store.close();
  now += 15_000;
  const restarted = await createEventStore({ directory: f.directory, now: () => now });
  assert.deepEqual(await restarted.list(), initial);
  assert.equal(initial.startedAt, at);
  assert.equal(initial.events[0].at, at - 1000);
  assert.deepEqual(initial.retention, RETENTION);
  const disk = JSON.parse(await readFile(f.file, 'utf8'));
  assert.equal(validateDocument(disk, now), true);
  assert.equal(disk.cursors.monitor.checkedAt, at - 1000);
});

test('storage retains at most 2000 events for 24 hours and returns at most 200 newest', async t => {
  const f = await fixture(t);
  let now = at;
  const store = await createEventStore({ directory: f.directory, now: () => now });
  await store.update(document => { document.events = Array.from({ length: 2000 }, (_, index) => event(index, at - index)); });
  await store.update(document => { document.events.push(event(2000, at)); });
  const page = await store.list();
  assert.equal(page.events.length, EVENT_PAGE_SIZE);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).events.length, RETENTION.maxEntries);
  assert.ok(page.events.every((item, index) => index === 0 || page.events[index - 1].at >= item.at));
  now += RETENTION.maxAgeMs + 1;
  assert.equal((await store.list()).events.length, 0);
  await store.update(document => { document.events.push(event(3000, now)); });
  assert.deepEqual((await store.list()).events, [event(3000, now)]);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).events.length, 1);
});

test('schema rejects private fields, invented pause reasons, wrong types, impossible counts and extra envelope fields', () => {
  const valid = event(1);
  assert.equal(validateEvent(valid, at), true);
  const release = { id: valid.id, at, type: 'monitor_released', level: 'info', source: 'monitor',
    status: 'released', capacity: 10, before: 10, after: 0, released: 10 };
  assert.equal(validateEvent(release, at), true);
  for (const invalid of [
    { ...valid, cookie: 'synthetic-secret' }, { ...valid, id: [valid.id] }, { ...valid, at: at + 1 },
    { ...valid, source: 'synthetic-user' }, { ...valid, used: -1 }, { ...valid, used: 10 },
    { ...valid, tenant: 'synthetic-tenant' }, { ...valid, error: 'synthetic-error' },
    { ...valid, reason: 'captcha' }, { ...valid, capacity: 9 }, { ...release, after: 10 },
    { ...release, released: 11 }, { ...release, type: 'test_verified' },
  ]) assert.equal(validateEvent(invalid, at), false);
  const document = { version: 1, startedAt: at, lastObservedAt: null, events: [valid],
    cursors: { monitor: null, test: null, connection: 'unknown', freshness: 'unknown', availability: 'unknown' } };
  assert.equal(validateDocument(document, at), true);
  assert.equal(validateDocument({ ...document, error: 'synthetic-secret' }, at), false);
  assert.equal(validateDocument({ ...document, events: [valid, valid] }, at), false);
  assert.throws(() => publicEvents({ ...document, tenant: 'synthetic-tenant' }, at), /events_unavailable/);
});

test('corrupt, oversized, extra-field and invalid UTF-8 files are rejected and never overwritten', async t => {
  for (const [name, body] of [
    ['syntax', '{"synthetic-private":"secret"'],
    ['schema', '{"cookie":"synthetic-secret"}'],
    ['size', 'x'.repeat(MAX_EVENT_FILE_BYTES + 1)],
    ['utf8', Buffer.from([0xff, 0xfe])],
  ]) await t.test(name, async child => {
    const f = await fixture(child);
    await writeFile(f.file, body, { mode: 0o600 });
    await assert.rejects(createEventStore({ directory: f.directory, now: () => at }), /events_unavailable/);
    assert.deepEqual(await readFile(f.file), Buffer.from(body));
  });
});

test('wrong directory/file permissions, owner, symlinks, directories and hardlinks fail closed', async t => {
  await t.test('directory mode', async child => {
    const f = await fixture(child); await chmod(f.directory, 0o755);
    await assert.rejects(createEventStore({ directory: f.directory, now: () => at }), /events_unavailable/);
  });
  await t.test('owner', async child => {
    const f = await fixture(child);
    await assert.rejects(createEventStore({ directory: f.directory, now: () => at, expectedUid: process.getuid() + 1 }), /events_unavailable/);
  });
  await t.test('file mode', async child => {
    const f = await fixture(child); await writeFile(f.file, '{}', { mode: 0o644 });
    await assert.rejects(createEventStore({ directory: f.directory, now: () => at }), /events_unavailable/);
    assert.equal(await readFile(f.file, 'utf8'), '{}');
  });
  await t.test('file symlink', async child => {
    const f = await fixture(child); const target = path.join(f.directory, 'target');
    await writeFile(target, 'synthetic-private', { mode: 0o600 }); await symlink(target, f.file);
    await assert.rejects(createEventStore({ directory: f.directory, now: () => at }), /events_unavailable/);
    assert.equal((await lstat(f.file)).isSymbolicLink(), true);
    assert.equal(await readFile(target, 'utf8'), 'synthetic-private');
  });
  await t.test('directory symlink', async child => {
    const f = await fixture(child); const alias = `${f.directory}-link`;
    child.after(() => rm(alias, { force: true })); await symlink(f.directory, alias);
    await assert.rejects(createEventStore({ directory: alias, now: () => at }), /events_unavailable/);
  });
  await t.test('file directory', async child => {
    const f = await fixture(child); await mkdir(f.file, { mode: 0o700 });
    await assert.rejects(createEventStore({ directory: f.directory, now: () => at }), /events_unavailable/);
  });
  await t.test('hardlink', async child => {
    const f = await fixture(child); await writeFile(f.file, '{}', { mode: 0o600 }); await link(f.file, path.join(f.directory, 'link'));
    await assert.rejects(createEventStore({ directory: f.directory, now: () => at }), /events_unavailable/);
    assert.equal(await readFile(f.file, 'utf8'), '{}');
  });
});

test('later tampering latches storage unavailable without overwriting the bad file or exposing errors', async t => {
  const f = await fixture(t);
  const store = await createEventStore({ directory: f.directory, now: () => at });
  await writeFile(f.file, 'synthetic-private-error', { mode: 0o600 });
  await assert.rejects(store.update(document => { document.events.push(event(1)); }), /^Error: events_unavailable$/);
  await assert.rejects(store.list(), /^Error: events_unavailable$/);
  assert.equal(await readFile(f.file, 'utf8'), 'synthetic-private-error');
});

test('invalid updates preserve the last valid disk document and make failure explicit', async t => {
  const f = await fixture(t);
  const store = await createEventStore({ directory: f.directory, now: () => at });
  const before = await readFile(f.file, 'utf8');
  await assert.rejects(store.update(document => { document.events.push({ ...event(1), cookie: 'synthetic-private' }); }), /events_unavailable/);
  assert.equal(await readFile(f.file, 'utf8'), before);
  await assert.rejects(store.list(), /events_unavailable/);
});
