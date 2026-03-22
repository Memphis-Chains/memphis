/**
 * Verify memphis_self_modify is registered in tool registry with correct metadata.
 */
import { describe, expect, it } from 'vitest';

import { getToolMeta, getToolsByTier } from '../../src/gateway/tool-registry.js';

describe('tool-registry: memphis_self_modify', () => {
  it('exists in registry with tier 2', () => {
    const meta = getToolMeta('memphis_self_modify');
    expect(meta).toBeDefined();
    expect(meta!.tier).toBe(2);
  });

  it('has execute and write capabilities', () => {
    const meta = getToolMeta('memphis_self_modify')!;
    expect(meta.capabilities).toContain('execute');
    expect(meta.capabilities).toContain('write');
  });

  it('is included in tier 2 tools', () => {
    const tier2 = getToolsByTier(2);
    const names = tier2.map((t) => t.name);
    expect(names).toContain('memphis_self_modify');
  });
});
