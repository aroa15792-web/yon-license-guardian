import { createHash } from 'node:crypto';

export const TARGET = Object.freeze({
  origin: 'https://c3.yonyoucloud.com',
  dashboard: '应用许可看板',
  domain: '供应链云',
  metric: '专业应用用户数',
  licenseCode: 'BIP0002YB',
  licenseType: 'SHAREUSER',
  controlPointCode: 'BIPSCM0201',
  labelDomain: 'MM',
  capacity: 10,
});

export class ObservationError extends Error {}

// The adapter must obtain these fields from a successful, fresh read of the
// dashboard AND its matching detail list, never from default values or config.
// TARGET describes expected observations; spreading it into a real snapshot
// does not prove scope. Missing source fields must make the adapter fail closed.
export function validate(snapshot, now = Date.now()) {
  const fail = reason => { throw new ObservationError(reason); };
  if (!snapshot || snapshot.status !== 'ok') fail('读取未成功，不能认定人数为 0');
  for (const [key, value] of Object.entries(TARGET)) {
    if (!Object.hasOwn(snapshot, key) || snapshot[key] !== value) fail(`目标或容量不匹配：${key}`);
  }
  if (snapshot.scopeVerified !== true || typeof snapshot.tenantKey !== 'string' ||
      !snapshot.tenantKey.trim()) fail('未核实企业与许可列表的对应关系');
  if (snapshot.unfiltered !== true || snapshot.complete !== true) fail('名单存在筛选或分页未读完');
  if (!Number.isFinite(snapshot.observedAt) || snapshot.observedAt > now ||
      now - snapshot.observedAt > 30_000) fail('读取时间无效或数据已过时');
  if (!Number.isInteger(snapshot.used) || snapshot.used < 0) fail('占用人数无效');
  if (!Array.isArray(snapshot.records) || snapshot.records.length !== snapshot.used) {
    fail('看板人数与明细条数不一致');
  }
  // In the real licence adapter, generic records.id must come from the actual
  // licence row's userId, not its unrelated MDF row id. Never invent a fallback.
  const ids = snapshot.records.map(row => row?.id);
  if (ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
    fail('占用记录标识缺失或重复');
  }
  if (snapshot.licenseState !== 'active') fail('目标许可状态不是有效');
  return snapshot;
}

export function fingerprint(snapshot) {
  return createHash('sha256').update(JSON.stringify({
    tenantKey: snapshot.tenantKey,
    ...Object.fromEntries(Object.keys(TARGET).map(key => [key, snapshot[key]])),
    ids: snapshot.records.map(row => row.id).sort(),
  })).digest('hex');
}

export function plan(snapshot, now = Date.now()) {
  validate(snapshot, now);
  if (snapshot.used < TARGET.capacity) return { action: 'wait', used: snapshot.used };
  return {
    action: 'release',
    used: snapshot.used,
    count: snapshot.records.length,
    ids: snapshot.records.map(row => row.id),
    fingerprint: fingerprint(snapshot),
    tenantKey: snapshot.tenantKey,
  };
}
