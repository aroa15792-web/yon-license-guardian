// The public record contract contains bounded scalars only. It cannot carry
// private source objects, account identifiers, error messages or pause reasons.
export const RETENTION = Object.freeze({ maxEntries: 2000, maxAgeMs: 86_400_000 });
export const EVENT_PAGE_SIZE = 200;
export const STALE_AFTER_MS = 180_000;
export const record = value => value && typeof value === 'object' && !Array.isArray(value);
export const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000;
export const keysAre = (value, keys) => record(value) && Object.keys(value).length === keys.length &&
  keys.every(key => Object.hasOwn(value, key));
export const timestamp = (value, now) => Number.isSafeInteger(value) && value >= 0 && value <= now;
const states = new Set(['checking', 'observing', 'preview', 'released', 'cooldown', 'changed_retry_next_cycle', 'paused', 'stopped']);
const validUnavailable = item => keysAre(item, ['status']) && item.status === 'unavailable';

export function validateStatus(value, now = Date.now()) {
  if (!keysAre(value, ['monitor', 'test'])) return false;
  const monitor = value.monitor;
  if (!validUnavailable(monitor)) {
    if (!record(monitor) || !states.has(monitor.status) || typeof monitor.enabled !== 'boolean' ||
        !timestamp(monitor.checkedAt, now)) return false;
    const basic = ['status', 'enabled', 'checkedAt'];
    if (['observing', 'preview'].includes(monitor.status)) {
      if (!keysAre(monitor, [...basic, 'capacity', 'used']) || monitor.capacity !== 10 || !count(monitor.used) ||
          (monitor.status === 'observing' && monitor.used >= 10) ||
          (monitor.status === 'preview' && (monitor.enabled || monitor.used < 10))) return false;
    } else if (monitor.status === 'released') {
      if (!keysAre(monitor, [...basic, 'capacity', 'before', 'after', 'released']) || !monitor.enabled ||
          monitor.capacity !== 10 || !count(monitor.before) || monitor.before < 10 || !count(monitor.after) ||
          monitor.after >= monitor.before || !count(monitor.released) || monitor.released < 1 ||
          monitor.released > monitor.before) return false;
    } else if (!keysAre(monitor, basic)) return false;
  }
  const result = value.test;
  if (result === null || validUnavailable(result)) return true;
  if (!record(result) || !['pending', 'verified'].includes(result.status) || !timestamp(result.checkedAt, now) ||
      !count(result.before) || result.before < 1) return false;
  if (result.status === 'pending') return keysAre(result, ['status', 'checkedAt', 'before']);
  return keysAre(result, ['status', 'checkedAt', 'before', 'after', 'released']) &&
    count(result.after) && result.after < result.before && count(result.released) &&
    result.released >= 1 && result.released <= result.before;
}

const eventBasics = ['id', 'at', 'type', 'level', 'source'];
const transitions = new Map([
  ['connection_unavailable', 'error'], ['connection_restored', 'info'],
  ['status_stale', 'warn'], ['status_fresh', 'info'],
  ['status_unavailable', 'error'], ['status_available', 'info'],
]);

export function validateEvent(event, now = Date.now()) {
  if (!record(event) || typeof event.id !== 'string' || !/^[a-f0-9]{32}$/.test(event.id) || !timestamp(event.at, now)) return false;
  if (transitions.has(event.type)) return keysAre(event, eventBasics) && event.source === 'collector' &&
    event.level === transitions.get(event.type);
  if (event.source === 'monitor') {
    if (!states.has(event.status)) return false;
    if (event.type === 'monitor_released') return event.status === 'released' && event.level === 'info' &&
      keysAre(event, [...eventBasics, 'status', 'capacity', 'before', 'after', 'released']) &&
      event.capacity === 10 && count(event.before) && event.before >= 10 && count(event.after) &&
      event.after < event.before && count(event.released) && event.released >= 1 && event.released <= event.before;
    if (event.type === 'monitor_paused') return event.status === 'paused' && event.level === 'warn' &&
      keysAre(event, [...eventBasics, 'status']);
    if (event.type === 'monitor_stopped') return event.status === 'stopped' && event.level === 'warn' &&
      keysAre(event, [...eventBasics, 'status']);
    if (event.type !== 'monitor_status' || ['released', 'paused', 'stopped'].includes(event.status) || event.level !== 'info') return false;
    if (['observing', 'preview'].includes(event.status)) return keysAre(event, [...eventBasics, 'status', 'used', 'capacity']) &&
      event.capacity === 10 && count(event.used) && (event.status === 'observing' ? event.used < 10 : event.used >= 10);
    return keysAre(event, [...eventBasics, 'status']);
  }
  if (event.source !== 'test' || event.level !== 'info' || !count(event.before) || event.before < 1) return false;
  if (event.type === 'test_pending') return event.status === 'pending' && keysAre(event, [...eventBasics, 'status', 'before']);
  return event.type === 'test_verified' && event.status === 'verified' &&
    keysAre(event, [...eventBasics, 'status', 'before', 'after', 'released']) && count(event.after) &&
    event.after < event.before && count(event.released) && event.released >= 1 && event.released <= event.before;
}

export function validateDocument(value, now = Date.now()) {
  if (!keysAre(value, ['version', 'startedAt', 'lastObservedAt', 'events', 'cursors']) || value.version !== 1 ||
      !timestamp(value.startedAt, now) || !(value.lastObservedAt === null || timestamp(value.lastObservedAt, now)) ||
      !Array.isArray(value.events) || value.events.length > RETENTION.maxEntries ||
      !value.events.every(event => validateEvent(event, now)) ||
      new Set(value.events.map(event => event.id)).size !== value.events.length ||
      !keysAre(value.cursors, ['monitor', 'test', 'connection', 'freshness', 'availability']) ||
      !['unknown', 'available', 'unavailable'].includes(value.cursors.connection) ||
      !['unknown', 'available', 'unavailable'].includes(value.cursors.availability) ||
      !['unknown', 'fresh', 'stale'].includes(value.cursors.freshness)) return false;
  if (value.cursors.monitor !== null && (!validateStatus({ monitor: value.cursors.monitor, test: null }, now) ||
      value.cursors.monitor.status === 'unavailable')) return false;
  return value.cursors.test === null || (validateStatus({ monitor: { status: 'unavailable' }, test: value.cursors.test }, now) &&
    value.cursors.test.status !== 'unavailable');
}

export function retainEvents(events, now) {
  return events.filter(event => event.at >= now - RETENTION.maxAgeMs)
    .sort((left, right) => right.at - left.at || right.id.localeCompare(left.id)).slice(0, RETENTION.maxEntries);
}

export function publicEvents(value, now = Date.now()) {
  if (!validateDocument(value, now)) throw new Error('events_unavailable');
  return { events: retainEvents(value.events, now).slice(0, EVENT_PAGE_SIZE), startedAt: value.startedAt,
    lastObservedAt: value.lastObservedAt, retention: { ...RETENTION } };
}
