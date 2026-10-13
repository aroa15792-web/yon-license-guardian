import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { publicEvents, retainEvents, validateDocument, validateEvent, RETENTION } from './event-contract.mjs';

export const EVENT_DIRECTORY = '/var/lib/yon-license-public-viewer';
export const EVENT_FILE = 'events.json';
export const MAX_EVENT_FILE_BYTES = 1_048_576;
const unavailable = () => new Error('events_unavailable');
const identity = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs });
const same = (left, right) => left && right && Object.keys(left).every(key => left[key] === right[key]);

export async function createEventStore({ directory = EVENT_DIRECTORY, now = Date.now, expectedUid = process.getuid() } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory !== path.resolve(directory) ||
      typeof now !== 'function' || !Number.isSafeInteger(expectedUid) || expectedUid < 0) throw unavailable();
  const file = path.join(directory, EVENT_FILE);
  let document;
  let knownIdentity = null;
  let available = true;
  let queue = Promise.resolve();

  async function safeDirectory() {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.uid !== expectedUid || (metadata.mode & 0o7777) !== 0o700) throw unavailable();
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const actual = await handle.stat();
    if (!actual.isDirectory() || actual.uid !== expectedUid || (actual.mode & 0o7777) !== 0o700 ||
        actual.ino !== metadata.ino || actual.dev !== metadata.dev) { await handle.close(); throw unavailable(); }
    return handle;
  }

  async function fileIdentity() {
    let metadata;
    try { metadata = await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!metadata.isFile() || metadata.uid !== expectedUid || (metadata.mode & 0o7777) !== 0o600 ||
        metadata.nlink !== 1 || metadata.size > MAX_EVENT_FILE_BYTES) throw unavailable();
    return identity(metadata);
  }

  async function healthy() {
    if (!available) throw unavailable();
    const handle = await safeDirectory();
    await handle.close();
    const current = await fileIdentity();
    if (knownIdentity ? !same(knownIdentity, current) : current !== null) throw unavailable();
  }

  async function save(next) {
    const at = now();
    if (!validateDocument({ ...next, events: [] }, at) || !Array.isArray(next.events) ||
        next.events.length > RETENTION.maxEntries + 10 || !next.events.every(event => validateEvent(event, at))) throw unavailable();
    next.events = retainEvents(next.events, at);
    if (!validateDocument(next, at)) throw unavailable();
    const body = Buffer.from(JSON.stringify(next), 'utf8');
    if (body.length > MAX_EVENT_FILE_BYTES) throw unavailable();
    await healthy();
    const directoryHandle = await safeDirectory();
    const temporary = path.join(directory, `.events-${randomBytes(16).toString('hex')}.tmp`);
    let created = false;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try { await handle.writeFile(body); await handle.sync(); } finally { await handle.close(); }
      // Detect unexpected changes before replacing the last known good file.
      await healthy();
      await rename(temporary, file);
      created = false;
      await directoryHandle.sync();
      knownIdentity = await fileIdentity();
      document = next;
    } finally {
      await directoryHandle.close();
      if (created) { try { await unlink(temporary); } catch { /* Do not leak path/errors. */ } }
    }
  }

  try {
    const handle = await safeDirectory();
    await handle.close();
    knownIdentity = await fileIdentity();
    if (knownIdentity) {
      const input = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!same(knownIdentity, identity(await input.stat()))) throw unavailable();
        const buffer = Buffer.alloc(MAX_EVENT_FILE_BYTES + 1);
        const { bytesRead } = await input.read(buffer, 0, buffer.length, 0);
        if (bytesRead > MAX_EVENT_FILE_BYTES) throw unavailable();
        document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)));
        if (!validateDocument(document, now())) throw unavailable();
        await healthy();
      } finally { await input.close(); }
    } else {
      document = { version: 1, startedAt: now(), lastObservedAt: null, events: [],
        cursors: { monitor: null, test: null, connection: 'unknown', freshness: 'unknown', availability: 'unknown' } };
      await save(document);
    }
  } catch { available = false; throw unavailable(); }

  return {
    async update(change) {
      const job = queue.then(async () => {
        try {
          await healthy();
          const next = structuredClone(document);
          change(next);
          await save(next);
        } catch { available = false; throw unavailable(); }
      });
      queue = job.catch(() => {});
      return job;
    },
    async list() {
      await queue;
      try { await healthy(); return publicEvents(document, now()); }
      catch { available = false; throw unavailable(); }
    },
    async close() { await queue; },
  };
}
