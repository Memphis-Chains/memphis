import { createHash } from 'node:crypto';

import { emergencyFallbackTag, writeEmergencyLog } from '../runtime/emergency-log.js';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface Alert {
  id?: string;
  severity: AlertSeverity;
  message: string;
  details?: Record<string, unknown>;
}

export interface AlertDelivery {
  ok: boolean;
  deduped: boolean;
  suppressedCount?: number;
}

export interface AlertEmitterOptions {
  dedupeWindowMs?: number;
  sendFn?: (alert: Alert) => Promise<void> | void;
}

interface DedupState {
  firstSeenAt: number;
  lastSentAt: number;
  suppressedCount: number;
}

function alertKey(alert: Alert): string {
  if (alert.id && alert.id.trim().length > 0) return alert.id.trim();
  return createHash('sha256')
    .update(`${alert.severity}|${alert.message}|${JSON.stringify(alert.details ?? {})}`, 'utf8')
    .digest('hex');
}

async function defaultSend(_alert: Alert): Promise<void> {
  // Placeholder transport. Real integrations are injected via sendFn.
}

export class AlertEmitter {
  private readonly dedupeWindowMs: number;
  private readonly state = new Map<string, DedupState>();
  private readonly sendFn: (alert: Alert) => Promise<void> | void;

  constructor(options: AlertEmitterOptions = {}) {
    this.dedupeWindowMs = options.dedupeWindowMs ?? 5 * 60 * 1000;
    this.sendFn = options.sendFn ?? defaultSend;
  }

  public async emit(alert: Alert, nowMs = Date.now()): Promise<AlertDelivery> {
    const key = alertKey(alert);
    const current = this.state.get(key);
    if (current && nowMs - current.lastSentAt < this.dedupeWindowMs) {
      current.suppressedCount += 1;
      this.state.set(key, current);
      return { ok: true, deduped: true, suppressedCount: current.suppressedCount };
    }

    if (!current) {
      this.state.set(key, {
        firstSeenAt: nowMs,
        lastSentAt: nowMs,
        suppressedCount: 0,
      });
    } else {
      current.lastSentAt = nowMs;
      this.state.set(key, current);
    }

    try {
      await this.sendFn(alert);
      return { ok: true, deduped: false };
    } catch (error) {
      writeEmergencyLog(
        emergencyFallbackTag(
          `alert delivery failed id=${key} message=${alert.message} error=${error instanceof Error ? error.message : String(error)}`,
        ),
      );
      return { ok: false, deduped: false };
    }
  }

  public async flushSuppressed(nowMs = Date.now()): Promise<void> {
    const keys = Array.from(this.state.keys());
    for (const key of keys) {
      const snapshot = this.state.get(key);
      if (!snapshot) continue;
      if (snapshot.suppressedCount <= 0) continue;
      if (nowMs - snapshot.lastSentAt < this.dedupeWindowMs) continue;

      const count = snapshot.suppressedCount;
      snapshot.suppressedCount = 0;
      snapshot.lastSentAt = nowMs;
      this.state.set(key, snapshot);

      await this.emit(
        {
          id: `AlertSuppressed:${key}`,
          severity: 'high',
          message: `AlertSuppressed`,
          details: { alertId: key, count },
        },
        nowMs,
      );
    }
  }
}
