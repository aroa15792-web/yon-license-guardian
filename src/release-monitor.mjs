import { Controller } from './controller.mjs';
import { ObservationError } from './policy.mjs';
import { FileJournalError } from './file-journal.mjs';
import { createStatusWriter } from './summary-monitor.mjs';

export const RELEASE_INTERVAL_MS = 60_000;
export const RELEASE_STATUS_DIRECTORY = '/var/lib/yon-license-monitor/release-monitor';
const PAUSE_REASONS = new Set([
  'needs_reconciliation', 'needs_login', 'access_denied', 'scope_mismatch',
  'invalid_observation', 'journal_error', 'unexpected_error', 'status_write_failed',
]);
const EXTRA_FIELDS = Object.freeze({
  checking: [], observing: ['used', 'capacity'], preview: ['used', 'capacity', 'count'],
  released: ['before', 'after', 'released', 'capacity'], cooldown: [],
  changed_retry_next_cycle: [], paused: ['reason'], stopped: [],
});
const isCount = value => Number.isSafeInteger(value) && value >= 0;
class StopRequested extends Error {}

// Public status is separate from the durable operation journal. It contains no
// record IDs, tenant IDs, operation IDs, fingerprints, payloads, or error messages.
export function validateReleaseStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid release status');
  const inputKeys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (inputKeys.some(key => !Object.hasOwn(descriptors[key], 'value'))) throw new TypeError('Invalid release status');
  value = Object.fromEntries(inputKeys.map(key => [key, descriptors[key].value]));
  const extra = Object.hasOwn(EXTRA_FIELDS, value.status) ? EXTRA_FIELDS[value.status] : undefined;
  if (!extra) throw new TypeError('Invalid release status');
  const keys = ['status', 'enabled', 'checkedAt', 'cycle', ...extra];
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) ||
      typeof value.enabled !== 'boolean' || !isCount(value.checkedAt) || !isCount(value.cycle)) {
    throw new TypeError('Invalid release status');
  }
  if (value.status === 'paused' && !PAUSE_REASONS.has(value.reason)) throw new TypeError('Invalid release status');
  if (extra.includes('capacity') && value.capacity !== 10) throw new TypeError('Invalid release status');
  if (value.status === 'observing' && (!isCount(value.used) || value.used >= 10)) throw new TypeError('Invalid release status');
  if (value.status === 'preview' && (value.enabled || !isCount(value.used) || value.used < 10 || value.count !== value.used)) {
    throw new TypeError('Invalid release status');
  }
  if (value.status === 'released' && (!value.enabled || !isCount(value.before) || value.before < 10 ||
      !isCount(value.after) || value.after >= value.before || !isCount(value.released) ||
      value.released < 1 || value.released > value.before)) throw new TypeError('Invalid release status');
  return Object.fromEntries(keys.map(key => [key, value[key]]));
}

export function createReleaseStatusWriter({ directory = RELEASE_STATUS_DIRECTORY } = {}) {
  const write = createStatusWriter({ directory });
  return state => write(validateReleaseStatus(state));
}

function pauseReason(error) {
  const reason = error?.pauseReason ?? error?.code;
  if (reason === 'needs_login') return 'needs_login';
  if (reason === 'access_denied') return 'access_denied';
  if (['wrong_tenant', 'wrong_target', 'scope_mismatch', 'wrong_scope'].includes(reason)) return 'scope_mismatch';
  if (error instanceof ObservationError) return 'invalid_observation';
  if (error instanceof FileJournalError) return 'journal_error';
  return 'unexpected_error';
}

/**
 * One Controller per monitor, never overlapping ticks; no HTTP adapter is built in.
 * `enabled` must be explicitly true or false. The adapter must provide complete,
 * freshly verified procurement snapshots and bounded RPC calls with no write retry.
 * Enforce one process externally (for example one dedicated systemd unit).
 * Pauses have no resume method: review the cause and journal before manual restart.
 * The interval remains referenced while paused, but performs no reads or writes.
 * stop() waits for existing RPCs; it prevents new adapter calls but cannot undo a
 * remote write already sent. Never replace this with a timeout-and-retry race.
 */
export function createReleaseMonitor({
  adapter, journal, enabled,
  writeStatus = createReleaseStatusWriter(), now = Date.now,
  log = state => console.log(JSON.stringify(state)),
  setEvery = setInterval, clearEvery = clearInterval,
} = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('enabled 必须显式设为 true 或 false');
  if (typeof adapter?.read !== 'function' || typeof adapter?.release !== 'function' ||
      typeof journal?.read !== 'function' || typeof journal?.write !== 'function' ||
      typeof writeStatus !== 'function' || typeof now !== 'function' || typeof log !== 'function' ||
      typeof setEvery !== 'function' || typeof clearEvery !== 'function') throw new TypeError('Invalid monitor dependencies');
  let active;
  let timer;
  let started = false;
  let stopped = false;
  let paused = false;
  let cycle = 0;
  let state;
  const assertRunning = () => { if (stopped || paused) throw new StopRequested(); };
  const controller = new Controller({ enabled, journal, now, adapter: {
    async read() {
      assertRunning();
      const result = await adapter.read();
      assertRunning();
      return result;
    },
    async release(operation) {
      assertRunning();
      return adapter.release(operation);
    },
  } });
  const base = () => ({ enabled, checkedAt: now(), cycle });
  const safeLog = value => {
    try { log(structuredClone(value)); return true; } catch { return false; }
  };
  const publish = async candidate => {
    state = validateReleaseStatus(candidate);
    try { await writeStatus(structuredClone(state)); } catch {
      paused = true;
      state = { status: 'paused', reason: 'status_write_failed', ...base() };
      safeLog(state);
      return false;
    }
    if (!safeLog(state)) {
      paused = true;
      state = { status: 'paused', reason: 'unexpected_error', ...base() };
      try { await writeStatus(structuredClone(state)); } catch { state.reason = 'status_write_failed'; }
    }
    return !paused;
  };
  const resultState = result => {
    const common = base();
    switch (result?.status) {
      case 'needs_reconciliation':
        paused = true;
        return { status: 'paused', reason: 'needs_reconciliation', ...common };
      case 'waiting': return { status: 'observing', used: result.used, capacity: 10, ...common };
      case 'preview': return { status: 'preview', used: result.used, count: result.count, capacity: 10, ...common };
      case 'verified': return { status: 'released', before: result.before, after: result.after, released: result.released, capacity: 10, ...common };
      case 'cooldown': return { status: 'cooldown', ...common };
      case 'changed_retry_next_cycle': return { status: 'changed_retry_next_cycle', ...common };
      default: throw new TypeError('Unexpected controller result');
    }
  };
  const snapshot = () => state ? structuredClone(state) : undefined;
  const tick = () => {
    if (active) return active;
    if (stopped || paused) return Promise.resolve(snapshot());
    active = (async () => {
      cycle++;
      // Status persistence must work before an enabled tick can reach a write.
      if (!await publish({ status: 'checking', ...base() }) || stopped) return snapshot();
      try {
        const result = await controller.tick();
        const next = resultState(result);
        await publish(stopped && !paused ? { status: 'stopped', ...base() } : next);
      } catch (error) {
        if (error instanceof StopRequested && stopped) {
          await publish({ status: 'stopped', ...base() });
        } else if (error?.code === 'snapshot_changed' && !stopped) {
          // Only pre-pending reads can escape Controller with this code.
          // Release-stage uncertainty is returned as needs_reconciliation.
          await publish({ status: 'changed_retry_next_cycle', ...base() });
        } else {
          paused = true;
          await publish({ status: 'paused', reason: pauseReason(error), ...base() });
        }
      }
      return snapshot();
    })().catch(async () => {
      paused = true;
      // A broken clock or status/log hook must not restart or repeat Controller.tick.
      const checkedAt = Date.now();
      state = { status: 'paused', reason: 'unexpected_error', enabled, checkedAt, cycle };
      try { await writeStatus(structuredClone(state)); } catch {}
      safeLog(state);
      return snapshot();
    }).finally(() => { active = undefined; });
    return active;
  };
  return {
    tick,
    start() {
      if (started || stopped) return active ?? Promise.resolve(snapshot());
      started = true;
      // Keep the process alive after a pause, without invoking any dependency.
      timer = setEvery(() => { if (!paused && !stopped) void tick(); }, RELEASE_INTERVAL_MS);
      return tick();
    },
    async stop() {
      stopped = true;
      if (timer !== undefined) clearEvery(timer);
      timer = undefined;
      await active;
      if (!paused && state?.status !== 'stopped') await publish({ status: 'stopped', ...base() });
      return snapshot();
    },
    getState: snapshot,
  };
}
