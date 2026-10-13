import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, readFile, writeFile, readdir, chmod, stat, symlink, link, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileJournal, FileJournalError } from '../src/file-journal.mjs';
import { Controller } from '../src/controller.mjs';

const pending = () => ({ status: 'pending', operationId: randomUUID(), at: 1_800_000_000_000, before: 10, fingerprint: 'a'.repeat(64) });
const verified = operation => ({ status: 'verified', operationId: operation.operationId, at: operation.at + 1000, before: 10, after: 2, released: 10 });
async function fixture(t) {
  const base = await mkdtemp(path.join(await realpath(os.tmpdir()), 'yon-journal-'));
  await chmod(base, 0o700);
  t.after(() => rm(base, { recursive: true, force: true }));
  const directory = path.join(base, 'journal');
  return { base, directory, file: path.join(directory, 'journal.json'), journal: new FileJournal({ directory }) };
}

test('pending survives a new instance; replacement is atomic and uses private permissions', async t => {
  const { directory, file, journal } = await fixture(t);
  assert.equal(await journal.read(), null);
  const first = pending();
  await journal.write(first);
  const inode = (await stat(file)).ino;
  assert.deepEqual(await new FileJournal({ directory }).read(), first);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const completed = verified(first);
  await journal.write(completed);
  assert.notEqual((await stat(file)).ino, inode);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), completed);
  assert.deepEqual(await readdir(directory), ['journal.json']);
});

test('a persisted pending record prevents all adapter work after controller restart', async t => {
  const { directory, journal } = await fixture(t);
  const operation = pending();
  await journal.write(operation);
  const controller = new Controller({
    enabled: true, journal: new FileJournal({ directory }),
    adapter: { read: () => assert.fail('must not read'), release: () => assert.fail('must not release') },
  });
  assert.deepEqual(await controller.tick(), { status: 'needs_reconciliation', operationId: operation.operationId });
});

test('corruption and extra fields are errors, never empty records or implicit repairs', async t => {
  const { file, journal } = await fixture(t);
  await journal.read();
  for (const content of ['{broken', 'null', JSON.stringify({ ...pending(), userIds: ['synthetic-person'] }),
    JSON.stringify({ ...pending(), status: 'unknown' }), JSON.stringify({ ...pending(), fingerprint: 'secret' })]) {
    await writeFile(file, content, { mode: 0o600 });
    await assert.rejects(journal.read(), { code: 'invalid_record' });
    await assert.rejects(journal.write(pending()), { code: 'invalid_record' });
    assert.equal(await readFile(file, 'utf8'), content);
  }
});

test('writes accept only the controller schema and do not persist IDs or credentials', async t => {
  const { directory, journal } = await fixture(t);
  const original = pending();
  await journal.write(original);
  for (const record of [
    { ...pending(), records: [] }, { ...pending(), token: 'synthetic-secret' },
    { ...pending(), operationId: 'synthetic-secret' }, { ...pending(), before: '10' },
    { ...pending(), at: NaN }, { ...verified(original), after: 10 },
    { ...verified(original), released: 11 },
  ]) await assert.rejects(journal.write(record), FileJournalError);
  let getterCalls = 0;
  const accessorRecord = { ...pending(), get fingerprint() { getterCalls++; return 'a'.repeat(64); } };
  await assert.rejects(journal.write(accessorRecord), { code: 'invalid_record' });
  assert.equal(getterCalls, 0);
  assert.deepEqual(await journal.read(), original);
  assert.deepEqual(await readdir(directory), ['journal.json']);
});

test('rejects symlink directories/files, hard links and non-private permissions', async t => {
  const { base, directory, file, journal } = await fixture(t);
  await journal.write(pending());
  const alias = path.join(base, 'alias');
  await symlink(directory, alias);
  await assert.rejects(new FileJournal({ directory: alias }).read(), { code: 'unsafe_path' });
  await assert.rejects(new FileJournal({ directory: path.join(alias, 'child') }).read(), { code: 'unsafe_path' });
  await chmod(directory, 0o755);
  await assert.rejects(journal.read(), { code: 'unsafe_path' });
  await chmod(directory, 0o700);
  await chmod(file, 0o644);
  await assert.rejects(journal.read(), { code: 'unsafe_path' });
  await chmod(file, 0o600);
  const outside = path.join(base, 'outside.json');
  await writeFile(outside, JSON.stringify(pending()), { mode: 0o600 });
  await rm(file);
  await symlink(outside, file);
  await assert.rejects(journal.read(), { code: 'unsafe_path' });
  await assert.rejects(journal.write(pending()), { code: 'unsafe_path' });
  await rm(file);
  await link(outside, file);
  await assert.rejects(journal.read(), { code: 'unsafe_path' });
});

test('failed file fsync leaves the previous record intact and rejects the write', async t => {
  const { file, directory, journal } = await fixture(t);
  const original = pending();
  await journal.write(original);
  const probe = await open(file, 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = prototype.sync;
  const mocked = t.mock.method(prototype, 'sync', async function () {
    if ((await this.stat()).isFile()) throw new Error('synthetic disk failure');
    return originalSync.call(this);
  });
  await assert.rejects(journal.write(verified(original)), { code: 'io_error' });
  mocked.mock.restore();
  assert.deepEqual(await journal.read(), original);
  assert.deepEqual(await readdir(directory), ['journal.json']);
});

test('directory fsync failure after rename is not reported as a successful durable write', async t => {
  const { file, journal } = await fixture(t);
  await journal.write(pending());
  const probe = await open(file, 'r');
  const prototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalSync = prototype.sync;
  let directorySyncs = 0;
  const mocked = t.mock.method(prototype, 'sync', async function () {
    if ((await this.stat()).isDirectory() && ++directorySyncs === 2) {
      throw new Error('synthetic directory durability failure');
    }
    return originalSync.call(this);
  });
  const next = pending();
  await assert.rejects(journal.write(next), { code: 'io_error' });
  mocked.mock.restore();
  assert.equal(directorySyncs, 2);
  // Rename can already be visible despite failed durability; never claim rollback.
  assert.deepEqual(await journal.read(), next);
});

test('concurrent readers see complete old or new records, never partial JSON', async t => {
  const { directory, journal } = await fixture(t);
  const first = pending();
  const second = verified(first);
  await journal.write(first);
  const reader = new FileJournal({ directory });
  await Promise.all([
    (async () => { for (let i = 0; i < 12; i++) await journal.write(i % 2 ? first : second); })(),
    (async () => {
      for (let i = 0; i < 24; i++) {
        const value = await reader.read();
        assert.ok(value.status === 'pending' || value.status === 'verified');
        assert.deepEqual(value, value.status === 'pending' ? first : second);
      }
    })(),
  ]);
});
