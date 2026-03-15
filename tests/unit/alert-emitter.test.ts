import { describe, expect, it } from 'vitest';

import { AlertEmitter } from '../../src/infra/logging/alert-emitter.js';

describe('alert emitter', () => {
  it('dedupes repeated alerts and emits suppression summary on flush', async () => {
    const sent: Array<{ id?: string; message: string; details?: Record<string, unknown> }> = [];
    const emitter = new AlertEmitter({
      dedupeWindowMs: 50,
      sendFn: async (alert) => {
        sent.push({ id: alert.id, message: alert.message, details: alert.details });
      },
    });

    const baseNow = 1_000;
    const first = await emitter.emit(
      { id: 'SecurityDegraded', severity: 'critical', message: 'safe mode no-egress failed' },
      baseNow,
    );
    const second = await emitter.emit(
      { id: 'SecurityDegraded', severity: 'critical', message: 'safe mode no-egress failed' },
      baseNow + 10,
    );

    expect(first).toEqual({ ok: true, deduped: false });
    expect(second).toEqual({ ok: true, deduped: true, suppressedCount: 1 });

    await emitter.flushSuppressed(baseNow + 80);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.id).toBe('AlertSuppressed:SecurityDegraded');
    expect(sent[1]?.details).toMatchObject({ alertId: 'SecurityDegraded', count: 1 });
  });

  it('logs alert fallback when all transports fail', async () => {
    const fallback: string[] = [];
    const emitter = new AlertEmitter({
      sendFn: async () => {
        throw new Error('transport down');
      },
      fallbackLogFn: (message) => {
        fallback.push(message);
      },
    });

    const out = await emitter.emit({
      id: 'TrustRootRejected',
      severity: 'critical',
      message: 'trust root rejected',
    });

    expect(out.ok).toBe(false);
    expect(out.deduped).toBe(false);
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toContain('[ALERT_FALLBACK]');
    expect(fallback[0]).toContain('TrustRootRejected');
  });
});
