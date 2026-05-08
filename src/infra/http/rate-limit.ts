/* eslint-disable no-restricted-syntax */
//
// rawEnv-threading default parameter or single-call config-source
// pattern. File-level disable per Sprint ι policy — accessor would
// add registry weight without consumer benefit.
//
import { AppError } from '../../core/errors.js';
import { registerPostApplyHook } from '../config/post-apply-hooks.js';

type Bucket = {
  count: number;
  resetAt: number;
};

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private checkCount = 0;
  private maxRequests: number;
  private readonly windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /** Operator-driven runtime adjustment (Sprint 6 deferral closed). */
  public setMaxRequests(value: number): { changed: boolean; previous: number; next: number } {
    const previous = this.maxRequests;
    if (!Number.isFinite(value) || value <= 0) {
      throw new AppError(
        'VALIDATION_ERROR',
        `setMaxRequests: expected a positive number, got ${value}`,
        400,
      );
    }
    const next = Math.floor(value);
    if (previous === next) return { changed: false, previous, next };
    this.maxRequests = next;
    return { changed: true, previous, next };
  }

  public getMaxRequests(): number {
    return this.maxRequests;
  }

  public check(key: string, now = Date.now()): void {
    this.checkCount += 1;
    if (this.checkCount % 1000 === 0) {
      for (const [k, b] of this.buckets) {
        if (now >= b.resetAt) this.buckets.delete(k);
      }
    }

    const bucket = this.buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return;
    }

    if (bucket.count >= this.maxRequests) {
      throw new AppError('PROVIDER_RATE_LIMIT', 'Rate limit exceeded', 429, {
        retryAfterMs: bucket.resetAt - now,
      });
    }

    bucket.count += 1;
    this.buckets.set(key, bucket);
  }
}

export const DEFAULT_GLOBAL_MAX = 100;
export const DEFAULT_SENSITIVE_MAX = 10;

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const globalLimiter = new RateLimiter(
  envInt('MEMPHIS_RATE_LIMIT_GLOBAL_MAX', DEFAULT_GLOBAL_MAX),
  60_000,
);
export const sensitiveLimiter = new RateLimiter(
  envInt('MEMPHIS_RATE_LIMIT_SENSITIVE_MAX', DEFAULT_SENSITIVE_MAX),
  60_000,
);
export const execLimiter = new RateLimiter(
  envInt('MEMPHIS_RATE_LIMIT_SENSITIVE_MAX', DEFAULT_SENSITIVE_MAX),
  60_000,
);

/**
 * Hot-swap: when the operator changes a rate-limit env via /config set,
 * the post-apply hook updates the live limiter cap. Without this, the
 * singleton's maxRequests was baked in at module-load time and Sprint 6's
 * `/config reload` had no effect on rate limits. Hooks are idempotent
 * (PR #99), so re-import of this module doesn't accumulate registrations.
 *
 * Codex P2 (Round 2): when an env var is UNSET (operator removes the
 * override), `ctx.nextValue` is undefined/empty. Previously the hook
 * no-op'd and the live limiter kept the stale cap from the last set.
 * The correct behaviour is to revert to the documented default so the
 * limiter matches what a fresh process with no override would use.
 */
function parseOrDefault(nextValue: string | undefined, fallback: number): number {
  if (!nextValue || nextValue.trim().length === 0) return fallback;
  const parsed = Number(nextValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

registerPostApplyHook(
  'MEMPHIS_RATE_LIMIT_GLOBAL_MAX',
  'rate-limit.globalLimiter.setMaxRequests',
  (ctx) => {
    globalLimiter.setMaxRequests(parseOrDefault(ctx.nextValue, DEFAULT_GLOBAL_MAX));
  },
);
registerPostApplyHook(
  'MEMPHIS_RATE_LIMIT_SENSITIVE_MAX',
  'rate-limit.sensitiveLimiter.setMaxRequests',
  (ctx) => {
    const next = parseOrDefault(ctx.nextValue, DEFAULT_SENSITIVE_MAX);
    sensitiveLimiter.setMaxRequests(next);
    execLimiter.setMaxRequests(next);
  },
);
