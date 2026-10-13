import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const messages = Object.freeze({
  unsafe_path: '持久记录路径或所有者不可信',
  invalid_record: '持久记录内容无效，需人工核对',
  io_error: '持久记录读写失败，不能继续释放',
});
const recordFields = Object.freeze({
  pending: ['status', 'operationId', 'at', 'before', 'fingerprint'],
  verified: ['status', 'operationId', 'at', 'before', 'after', 'released'],
});

export class FileJournalError extends Error {
  constructor(code) {
    super(messages[code]);
    this.name = 'FileJournalError';
    this.code = code;
  }
}
const fail = code => { throw new FileJournalError(code); };
const safeCount = value => Number.isSafeInteger(value) && value >= 0;

function validateRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('invalid_record');
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some(key => !Object.hasOwn(descriptors[key], 'value'))) fail('invalid_record');
  // Validate the same immutable-in-this-call values that will be serialized,
  // rather than repeatedly consulting a caller-owned object or proxy.
  value = Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
  const fields = Object.hasOwn(recordFields, value.status) ? recordFields[value.status] : undefined;
  if (!fields || keys.length !== fields.length || keys.some(key => !fields.includes(key))) fail('invalid_record');
  if (typeof value.operationId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.operationId) ||
      !safeCount(value.at) || !safeCount(value.before) || value.before < 1) fail('invalid_record');
  if (value.status === 'pending') {
    if (typeof value.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.fingerprint)) fail('invalid_record');
  } else if (!safeCount(value.after) || value.after >= value.before || !safeCount(value.released) ||
      value.released < 1 || value.released > value.before) fail('invalid_record');
  // Select the exact schema; getters, prototypes and additional data are not serialized.
  return Object.fromEntries(fields.map(field => [field, descriptors[field].value]));
}

function verifyDirectory(metadata, owner, privateDirectory = false) {
  if (!metadata.isDirectory() || (metadata.uid !== owner && metadata.uid !== 0)) fail('unsafe_path');
  if (privateDirectory) {
    if (metadata.uid !== owner || (metadata.mode & 0o7777) !== 0o700) fail('unsafe_path');
  } else if ((metadata.mode & 0o022) && !(metadata.mode & 0o1000)) {
    // A root-owned sticky temporary directory is safe for a private owned child.
    fail('unsafe_path');
  }
}

function verifyFile(metadata, owner, opened = false) {
  if (!metadata.isFile() || metadata.uid !== owner ||
      (metadata.nlink !== 1 && !(opened && metadata.nlink === 0)) ||
      (metadata.mode & 0o7777) !== 0o600) fail('unsafe_path');
  if (metadata.size > 4096) fail('invalid_record');
}

/**
 * Controller journal only, not a cross-process lock. Use one writer externally.
 * Supply an absolute canonical directory (no symlink components). A missing leaf
 * directory is created privately; existing parents and directories are not chmodded.
 * Failed reads/writes reject. Only a genuinely absent journal is represented by null.
 */
export class FileJournal {
  #directory;
  #filename;
  #owner;
  #tail = Promise.resolve();

  constructor({ directory, filename = 'journal.json' } = {}) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0') ||
        directory.split(path.sep).some(segment => segment === '..') ||
        typeof filename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(filename)) fail('unsafe_path');
    this.#directory = path.normalize(directory);
    this.#filename = filename;
    this.#owner = process.getuid();
  }

  #serialize(operation) {
    const result = this.#tail.then(operation).catch(error => {
      if (error instanceof FileJournalError && Object.hasOwn(messages, error.code)) {
        throw new FileJournalError(error.code);
      }
      throw new FileJournalError('io_error');
    });
    this.#tail = result.catch(() => {});
    return result;
  }

  async #openDirectory() {
    const parent = path.dirname(this.#directory);
    let current = path.parse(parent).root;
    verifyDirectory(await lstat(current), this.#owner);
    for (const segment of parent.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      verifyDirectory(await lstat(current), this.#owner);
    }
    try {
      await mkdir(this.#directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    verifyDirectory(await lstat(this.#directory), this.#owner, true);
    // Persist the private leaf's directory entry too, including after a previous
    // interrupted mkdir/fsync. Syncing only the leaf would not make its name durable.
    const parentHandle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      verifyDirectory(await parentHandle.stat(), this.#owner);
      await parentHandle.sync();
    } finally {
      await parentHandle.close();
    }
    const handle = await open(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      verifyDirectory(await handle.stat(), this.#owner, true);
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async #assertSameDirectory(handle) {
    const expected = await handle.stat();
    const actual = await lstat(this.#directory);
    verifyDirectory(actual, this.#owner, true);
    if (actual.dev !== expected.dev || actual.ino !== expected.ino) fail('unsafe_path');
  }

  async #readFile(directoryHandle) {
    await this.#assertSameDirectory(directoryHandle);
    const target = path.join(this.#directory, this.#filename);
    let metadata;
    try { metadata = await lstat(target); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    verifyFile(metadata, this.#owner);
    let handle;
    try {
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      verifyFile(opened, this.#owner, true);
      // A concurrent atomic rename may legitimately change the inode. The opened
      // regular file is independently checked and cannot be a symlink or hard link.
    } catch (error) {
      if (handle) await handle.close();
      // An entry disappearing between lstat and open is not a clean empty state.
      throw error;
    }
    try {
      let record;
      try { record = JSON.parse(await handle.readFile('utf8')); } catch { fail('invalid_record'); }
      const validated = validateRecord(record);
      await this.#assertSameDirectory(directoryHandle);
      return validated;
    } finally {
      await handle.close();
    }
  }

  read() {
    return this.#serialize(async () => {
      const directory = await this.#openDirectory();
      try { return await this.#readFile(directory); } finally { await directory.close(); }
    });
  }

  write(value) {
    return this.#serialize(async () => {
      const record = validateRecord(value);
      const directory = await this.#openDirectory();
      const temporaryPath = path.join(this.#directory, `.${this.#filename}.${randomUUID()}.tmp`);
      const target = path.join(this.#directory, this.#filename);
      let temporary;
      let temporaryCreated = false;
      let moved = false;
      try {
        // Never silently overwrite a damaged or untrusted existing record.
        await this.#readFile(directory);
        temporary = await open(temporaryPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        temporaryCreated = true;
        verifyFile(await temporary.stat(), this.#owner);
        await temporary.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
        await temporary.sync();
        await temporary.close();
        temporary = undefined;
        await this.#assertSameDirectory(directory);
        await this.#readFile(directory);
        await rename(temporaryPath, target);
        moved = true;
        await directory.sync();
      } finally {
        if (temporary) await temporary.close();
        if (temporaryCreated && !moved) await unlink(temporaryPath).catch(() => {});
        await directory.close();
      }
    });
  }
}
