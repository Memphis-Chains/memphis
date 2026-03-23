import { AppError } from '../../core/errors.js';

type Bucket = {
  count: number;
  resetAt: number;
};

export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private checkCount = 0;

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
  ) {}

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

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const globalLimiter = new RateLimiter(envInt('MEMPHIS_RATE_LIMIT_GLOBAL_MAX', 100), 60_000);
export const sensitiveLimiter = new RateLimiter(
  envInt('MEMPHIS_RATE_LIMIT_SENSITIVE_MAX', 10),
  60_000,
);
export const execLimiter = new RateLimiter(envInt('MEMPHIS_RATE_LIMIT_SENSITIVE_MAX', 10), 60_000);
