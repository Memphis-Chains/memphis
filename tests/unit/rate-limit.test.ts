import { describe, expect, it } from 'vitest';

import { RateLimiter } from '../../src/infra/http/rate-limit.js';

describe('RateLimiter', () => {
  it('throws when limit exceeded inside window', () => {
    const rl = new RateLimiter(2, 1000);
    rl.check('k', 1000);
    rl.check('k', 1001);
    expect(() => rl.check('k', 1002)).toThrow(/Rate limit exceeded/);
  });

  it('resets after window', () => {
    const rl = new RateLimiter(1, 1000);
    rl.check('k', 1000);
    expect(() => rl.check('k', 1001)).toThrow();
    expect(() => rl.check('k', 2001)).not.toThrow();
  });
});
