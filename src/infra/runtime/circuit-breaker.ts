/**
 * Per-provider circuit breaker (Phase 2.1 production sprint).
 *
 * If Ollama hangs for 60s, every request routed to Ollama hangs for
 * 60s. The cascade catches errors but not slow timeouts past some
 * threshold. One stuck provider = every request stuck. Grafana spikes,
 * users see "the bot is dead." Standard breaker pattern fixes this.
 *
 * Three states (Hystrix-style):
 *   - CLOSED     — normal, requests pass through
 *   - OPEN       — too many recent failures; fail fast (immediate
 *                  throw so cascade falls through to the next tier)
 *   - HALF_OPEN  — cooldown elapsed; let ONE request through to probe
 *                  recovery. Success → CLOSED. Failure → back to OPEN.
 *
 * Failure window: rolling N seconds with up to M failures. Operator-
 * tunable per provider via env. Defaults are conservative for an
 * operator who hasn't tuned yet.
 *
 * /v1/ops/status surfaces breaker state per provider so operators see
 * "anthropic OPEN since 14:23" instead of guessing why latency spiked.
 */

import { AppError } from '../../core/errors.js';

export type BreakerState = 'closed' | 'open' | 'half-open';

export interface BreakerSnapshot {
  provider: string;
  state: BreakerState;
  recentFailures: number;
  failureThreshold: number;
  windowMs: number;
  cooldownMs: number;
  lastFailureAt?: string;
  openedAt?: string;
  halfOpenAt?: string;
  totalTrips: number;
  totalRecoveries: number;
}

interface BreakerRecord {
  state: BreakerState;
  failureTimestamps: number[];
  lastFailureAt?: number;
  openedAt?: number;
  halfOpenAt?: number;
  /** Used to admit ONLY ONE probe request when half-open */
  halfOpenProbeInFlight: boolean;
  totalTrips: number;
  totalRecoveries: number;
}

const breakers = new Map<string, BreakerRecord>();

export const DEFAULT_FAILURE_THRESHOLD = 5;
export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_COOLDOWN_MS = 30_000;

function getOrCreate(provider: string): BreakerRecord {
  let rec = breakers.get(provider);
  if (!rec) {
    rec = {
      state: 'closed',
      failureTimestamps: [],
      halfOpenProbeInFlight: false,
      totalTrips: 0,
      totalRecoveries: 0,
    };
    breakers.set(provider, rec);
  }
  return rec;
}

function envThresholds(
  provider: string,
  rawEnv: NodeJS.ProcessEnv,
): { failureThreshold: number; windowMs: number; cooldownMs: number } {
  const upper = provider.toUpperCase().replaceAll('-', '_');
  const failureThreshold =
    parsePositiveInt(rawEnv[`MEMPHIS_BREAKER_${upper}_FAILURES`]) ??
    parsePositiveInt(rawEnv.MEMPHIS_BREAKER_DEFAULT_FAILURES) ??
    DEFAULT_FAILURE_THRESHOLD;
  const windowMs =
    parsePositiveInt(rawEnv[`MEMPHIS_BREAKER_${upper}_WINDOW_MS`]) ??
    parsePositiveInt(rawEnv.MEMPHIS_BREAKER_DEFAULT_WINDOW_MS) ??
    DEFAULT_WINDOW_MS;
  const cooldownMs =
    parsePositiveInt(rawEnv[`MEMPHIS_BREAKER_${upper}_COOLDOWN_MS`]) ??
    parsePositiveInt(rawEnv.MEMPHIS_BREAKER_DEFAULT_COOLDOWN_MS) ??
    DEFAULT_COOLDOWN_MS;
  return { failureThreshold, windowMs, cooldownMs };
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

/**
 * Pre-flight gate. Throws PROVIDER_RATE_LIMIT (429) when the breaker
 * is OPEN so the cascade falls through fast. When HALF_OPEN, allows
 * exactly ONE probe request through.
 */
export function admitProviderCall(
  provider: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): void {
  const rec = getOrCreate(provider);
  const { cooldownMs } = envThresholds(provider, rawEnv);

  if (rec.state === 'open') {
    // Has the cooldown elapsed? If yes, transition to half-open and
    // admit the probe; if no, fail fast.
    if (rec.openedAt !== undefined && now - rec.openedAt >= cooldownMs) {
      rec.state = 'half-open';
      rec.halfOpenAt = now;
      rec.halfOpenProbeInFlight = true;
      return;
    }
    throw new AppError(
      'PROVIDER_RATE_LIMIT',
      `provider ${provider} circuit breaker is OPEN — failing fast (cascade will fall through)`,
      429,
      { provider, state: 'open', cooldownMs },
    );
  }

  if (rec.state === 'half-open') {
    if (rec.halfOpenProbeInFlight) {
      // A probe is already in flight; subsequent calls fail fast.
      throw new AppError(
        'PROVIDER_RATE_LIMIT',
        `provider ${provider} circuit breaker is HALF-OPEN — probe in flight, failing fast`,
        429,
        { provider, state: 'half-open' },
      );
    }
    rec.halfOpenProbeInFlight = true;
    return;
  }

  // CLOSED — admit normally
}

/**
 * Record the outcome of a provider call. Failures may trip the breaker;
 * a half-open success closes it; a half-open failure re-opens.
 */
export function recordProviderOutcome(
  provider: string,
  ok: boolean,
  rawEnv: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): void {
  const rec = getOrCreate(provider);
  const { failureThreshold, windowMs } = envThresholds(provider, rawEnv);

  if (rec.state === 'half-open') {
    rec.halfOpenProbeInFlight = false;
    if (ok) {
      // Probe succeeded — close the breaker
      rec.state = 'closed';
      rec.failureTimestamps = [];
      rec.openedAt = undefined;
      rec.halfOpenAt = undefined;
      rec.totalRecoveries += 1;
    } else {
      // Probe failed — back to open with a fresh cooldown
      rec.state = 'open';
      rec.openedAt = now;
      rec.lastFailureAt = now;
      rec.totalTrips += 1;
    }
    return;
  }

  if (ok) {
    // Successful call in CLOSED state — drop stale failures
    rec.failureTimestamps = rec.failureTimestamps.filter((t) => now - t < windowMs);
    return;
  }

  // Failure in CLOSED state
  rec.failureTimestamps.push(now);
  rec.lastFailureAt = now;
  rec.failureTimestamps = rec.failureTimestamps.filter((t) => now - t < windowMs);
  if (rec.failureTimestamps.length >= failureThreshold) {
    rec.state = 'open';
    rec.openedAt = now;
    rec.totalTrips += 1;
  }
}

export function getBreakerSnapshot(
  provider: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): BreakerSnapshot {
  const rec = getOrCreate(provider);
  const { failureThreshold, windowMs, cooldownMs } = envThresholds(provider, rawEnv);
  return {
    provider,
    state: rec.state,
    recentFailures: rec.failureTimestamps.length,
    failureThreshold,
    windowMs,
    cooldownMs,
    lastFailureAt: rec.lastFailureAt
      ? new Date(rec.lastFailureAt).toISOString()
      : undefined,
    openedAt: rec.openedAt ? new Date(rec.openedAt).toISOString() : undefined,
    halfOpenAt: rec.halfOpenAt ? new Date(rec.halfOpenAt).toISOString() : undefined,
    totalTrips: rec.totalTrips,
    totalRecoveries: rec.totalRecoveries,
  };
}

export function getAllBreakerSnapshots(
  rawEnv: NodeJS.ProcessEnv = process.env,
): BreakerSnapshot[] {
  return Array.from(breakers.keys()).map((provider) => getBreakerSnapshot(provider, rawEnv));
}

/** Test-only. */
export function __resetBreakersForTests(): void {
  breakers.clear();
}
