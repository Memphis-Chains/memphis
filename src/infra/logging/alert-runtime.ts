import { AlertEmitter } from './alert-emitter.js';

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (typeof raw !== 'string') return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

let runtimeEmitter: AlertEmitter | null = null;
let suppressionFlushTimer: ReturnType<typeof setInterval> | null = null;

export function getRuntimeAlertEmitter(rawEnv: NodeJS.ProcessEnv = process.env): AlertEmitter {
  if (runtimeEmitter) return runtimeEmitter;
  runtimeEmitter = new AlertEmitter({
    dedupeWindowMs: parsePositiveInt(rawEnv.MEMPHIS_ALERT_DEDUPE_WINDOW_MS, 5 * 60 * 1000),
  });
  return runtimeEmitter;
}

export function startAlertSuppressionFlushLoop(rawEnv: NodeJS.ProcessEnv = process.env): void {
  if (suppressionFlushTimer) return;

  const intervalMs = parsePositiveInt(rawEnv.MEMPHIS_ALERT_SUMMARY_INTERVAL_MS, 5 * 60 * 1000);
  suppressionFlushTimer = setInterval(() => {
    const emitter = getRuntimeAlertEmitter(rawEnv);
    void emitter.flushSuppressed();
  }, intervalMs);
  suppressionFlushTimer.unref?.();
}

export function stopAlertRuntimeForTests(): void {
  if (suppressionFlushTimer) {
    clearInterval(suppressionFlushTimer);
    suppressionFlushTimer = null;
  }
  runtimeEmitter = null;
}
