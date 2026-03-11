import { describe, expect, it } from 'vitest';

import { profileCommand } from '../../src/infra/cli/commands/debug.js';

describe('debug profile', () => {
  it('returns function breakdown and bottleneck marks', () => {
    const result = profileCommand('node -e "console.log(1)"');
    expect(result.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.functions.length).toBeGreaterThan(0);
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result).toHaveProperty('baselineMs');
    expect(result).toHaveProperty('deltaMs');
  });
});
