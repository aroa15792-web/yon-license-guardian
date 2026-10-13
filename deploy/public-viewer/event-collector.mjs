import { createHash } from 'node:crypto';
import { STALE_AFTER_MS, validateStatus } from './event-contract.mjs';

export const COLLECTION_INTERVAL_MS = 15_000;
const monitorTypes = { released: 'monitor_released', paused: 'monitor_paused', stopped: 'monitor_stopped' };
const eventId = event => createHash('sha256').update(JSON.stringify(event)).digest('hex').slice(0, 32);
const makeEvent = (at, type, level, source, fields = {}) => {
  const event = { at, type, level, source, ...fields };
  return { id: eventId(event), ...event };
};
const projectMonitor = monitor => {
  const clean = { status: monitor.status, enabled: monitor.enabled, checkedAt: monitor.checkedAt };
  for (const key of ['capacity', 'used', 'before', 'after', 'released']) if (Object.hasOwn(monitor, key)) clean[key] = monitor[key];
  return clean;
};
const projectTest = result => {
  const clean = { status: result.status, checkedAt: result.checkedAt, before: result.before };
  for (const key of ['after', 'released']) if (Object.hasOwn(result, key)) clean[key] = result[key];
  return clean;
};

// Poll only the already-sanitized HTTP status contract, never monitor state,
// the private journal, browser-control or any licence mutation endpoint.
export function createEventCollector({ store, readStatus, now = Date.now,
  intervalMs = COLLECTION_INTERVAL_MS, staleAfterMs = STALE_AFTER_MS } = {}) {
  if (!store || typeof store.update !== 'function' || typeof readStatus !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 1 || !Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1) {
    throw new Error('events_unavailable');
  }
  let timer;
  let pending = null;
  let started = false;
  let stopped = false;
  let storageAvailable = true;

  const sample = async () => {
    let value;
    try {
      value = await readStatus();
      if (!validateStatus(value, now())) throw new Error();
    } catch { value = null; }
    const at = now();
    if (!storageAvailable) return;
    try {
      await store.update(document => {
        const add = event => { if (!document.events.some(item => item.id === event.id)) document.events.push(event); };
        if (!value) {
          if (document.cursors.connection !== 'unavailable') add(makeEvent(at, 'connection_unavailable', 'error', 'collector'));
          document.cursors.connection = 'unavailable';
          return;
        }
        document.lastObservedAt = at;
        if (document.cursors.connection === 'unavailable') add(makeEvent(at, 'connection_restored', 'info', 'collector'));
        document.cursors.connection = 'available';
        const monitor = value.monitor;
        const availability = monitor.status === 'unavailable' ? 'unavailable' : 'available';
        if (availability === 'unavailable' && document.cursors.availability !== 'unavailable') add(makeEvent(at, 'status_unavailable', 'error', 'collector'));
        if (availability === 'available' && document.cursors.availability === 'unavailable') add(makeEvent(at, 'status_available', 'info', 'collector'));
        document.cursors.availability = availability;
        if (monitor.status !== 'unavailable') {
          const previous = document.cursors.monitor;
          if (!previous || monitor.checkedAt >= previous.checkedAt) {
            const clean = projectMonitor(monitor);
            if (JSON.stringify(clean) !== JSON.stringify(previous)) {
              const fields = { status: clean.status };
              for (const key of ['used', 'capacity', 'before', 'after', 'released']) if (Object.hasOwn(clean, key)) fields[key] = clean[key];
              const type = monitorTypes[clean.status] || 'monitor_status';
              add(makeEvent(clean.checkedAt, type, ['paused', 'stopped'].includes(clean.status) ? 'warn' : 'info', 'monitor', fields));
              document.cursors.monitor = clean;
            }
            const freshness = at - monitor.checkedAt > staleAfterMs ? 'stale' : 'fresh';
            if (freshness === 'stale' && document.cursors.freshness !== 'stale') add(makeEvent(at, 'status_stale', 'warn', 'collector'));
            if (freshness === 'fresh' && document.cursors.freshness === 'stale') add(makeEvent(at, 'status_fresh', 'info', 'collector'));
            document.cursors.freshness = freshness;
          }
        }
        const result = value.test;
        if (result && result.status !== 'unavailable') {
          const previous = document.cursors.test;
          if (!previous || result.checkedAt >= previous.checkedAt) {
            const clean = projectTest(result);
            if (JSON.stringify(clean) !== JSON.stringify(previous)) {
              const fields = { status: clean.status, before: clean.before };
              for (const key of ['after', 'released']) if (Object.hasOwn(clean, key)) fields[key] = clean[key];
              add(makeEvent(clean.checkedAt, `test_${clean.status}`, 'info', 'test', fields));
              document.cursors.test = clean;
            }
          }
        }
      });
    } catch { storageAvailable = false; }
  };
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => { void tick().finally(schedule); }, intervalMs);
    timer.unref?.();
  };
  const tick = () => {
    if (stopped) return Promise.resolve();
    pending ??= sample().finally(() => { pending = null; });
    return pending;
  };
  return {
    tick,
    start() { if (!stopped && !started) { started = true; void tick().finally(schedule); } },
    async close() { stopped = true; clearTimeout(timer); await pending; await store.close(); },
  };
}
