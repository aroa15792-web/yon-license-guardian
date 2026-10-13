import { randomUUID } from 'node:crypto';
import { fingerprint, plan, validate } from './policy.mjs';

/**
 * Transport-independent controller. No live adapter is implemented yet.
 * adapter.read(): fresh verified snapshot matching policy.mjs.
 * adapter.release({ids, expectedFingerprint, tenantKey, operationId}): the
 * exact license-release operation; must recheck target/selection before click.
 * journal.read()/write(): durable state; pending MUST survive a restart.
 * A transport error after release is ambiguous and must not cause a retry.
 */
export class Controller {
  constructor({ adapter, journal, enabled = false, now = Date.now }) {
    if (typeof enabled !== 'boolean') throw new TypeError('enabled 必须是布尔值');
    this.adapter = adapter;
    this.journal = journal;
    this.enabled = enabled;
    this.now = now;
    this.running = false;
  }

  async tick() {
    if (this.running) return { status: 'busy' };
    this.running = true;
    try {
      const previous = await this.journal.read();
      if (previous?.status === 'pending') {
        return { status: 'needs_reconciliation', operationId: previous.operationId };
      }
      const first = await this.adapter.read();
      const proposed = plan(first, this.now());
      if (proposed.action === 'wait') return { status: 'waiting', used: proposed.used };
      if (!this.enabled) return { status: 'preview', used: proposed.used, count: proposed.count };
      if (previous?.status === 'verified' && this.now() - previous.at < 60_000) {
        return { status: 'cooldown' };
      }

      // A second read catches manual changes and concurrent additions.
      const before = validate(await this.adapter.read(), this.now());
      if (fingerprint(before) !== proposed.fingerprint) return { status: 'changed_retry_next_cycle' };
      const operationId = randomUUID();
      // Journal contains neither credentials nor employee identities.
      await this.journal.write({
        status: 'pending', operationId, at: this.now(),
        before: before.used, fingerprint: proposed.fingerprint,
      });
      try {
        const result = await this.adapter.release({
          ids: proposed.ids,
          expectedFingerprint: proposed.fingerprint,
          tenantKey: proposed.tenantKey,
          operationId,
        });
        if (result?.status !== 'acknowledged') throw new Error('释放结果不确定');
        const after = validate(await this.adapter.read(), this.now());
        const remaining = new Set(after.records.map(row => row.id));
        if (after.tenantKey !== before.tenantKey || after.used >= before.used ||
            proposed.ids.some(id => remaining.has(id))) {
          throw new Error('无法核实所选占用记录已释放');
        }
        await this.journal.write({
          status: 'verified', operationId, at: this.now(),
          before: before.used, after: after.used, released: proposed.count,
        });
        return { status: 'verified', before: before.used, after: after.used, released: proposed.count };
      } catch {
        // Keep durable pending state. Do not repeat a possibly successful write.
        return { status: 'needs_reconciliation', operationId };
      }
    } finally {
      this.running = false;
    }
  }
}
