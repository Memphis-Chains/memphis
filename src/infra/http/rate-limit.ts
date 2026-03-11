import { AppError } from '../../core/errors.js';

type Bucket = {
  count: number;
  resetAt: number;
};

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private readonly maxRequests: number, private readonly windowMs: number) {}

  public check(key: string, now = Date.now()): void {
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

export const globalLimiter = new RateLimiter(100, 60_000);
export const sensitiveLimiter = new RateLimiter(10, 60_000);
export const execLimiter = new RateLimiter(10, 60_000);
