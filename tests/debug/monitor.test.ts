import { describe, expect, it } from 'vitest';

import { monitorRuntime } from '../../src/infra/cli/commands/debug.js';

describe('debug monitor', () => {
  it('streams runtime points and produces summary', async () => {
    const result = await monitorRuntime(20, 120);
    expect(result.points.length).toBeGreaterThan(0);
    expect(result.summary.ticks).toBe(result.points.length);
    expect(result.summary.avgLatencyMs).toBeGreaterThanOrEqual(0);
  });
});
