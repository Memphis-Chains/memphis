/**
 * Exponential backoff retry utility with jitter.
 *
 * Retries a function on retryable errors (network failures, 5xx, 429).
 * Non-retryable errors (4xx except 429) are thrown immediately.
 */

export class RetryableError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'RetryableError';
  }
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof RetryableError) return true;
  if (err instanceof Error) {
    // Network failures (fetch throws TypeError)
    if (err.name === 'TypeError' && err.message.includes('fetch')) return true;
    if (err.message.includes('ECONNREFUSED') || err.message.includes('ENOTFOUND')) return true;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: { maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 500, maxDelayMs = 30_000 } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      if (!isRetryableError(err)) throw err;

      const delay = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const jitter = Math.random() * 100;
      await sleep(delay + jitter);
    }
  }

  throw new Error('unreachable');
}
