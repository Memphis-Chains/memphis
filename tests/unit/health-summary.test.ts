import { describe, expect, it } from 'vitest';

import { computeHealthSummary } from '../../src/infra/ops/health-summary.js';

describe('health summary', () => {
  it('returns green when all providers healthy', () => {
    const out = computeHealthSummary({
      uptimeSec: 10,
      providers: [
        { name: 'local-fallback', ok: true },
        { name: 'shared-llm', ok: true },
      ],
    });
    expect(out.color).toBe('green');
  });

  it('returns yellow when partially healthy', () => {
    const out = computeHealthSummary({
      uptimeSec: 10,
      providers: [
        { name: 'local-fallback', ok: true },
        { name: 'shared-llm', ok: false },
      ],
    });
    expect(out.color).toBe('yellow');
  });

  it('returns red when none healthy', () => {
    const out = computeHealthSummary({
      uptimeSec: 10,
      providers: [{ name: 'local-fallback', ok: false }],
    });
    expect(out.color).toBe('red');
  });
});
