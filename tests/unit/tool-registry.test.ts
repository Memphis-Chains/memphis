/**
 * Unit tests for the centralized tool registry.
 */
import { describe, expect, it } from 'vitest';

import {
  getToolMeta,
  getToolNames,
  getToolsByTier,
  TOOL_REGISTRY,
} from '../../src/gateway/tool-registry.js';

describe('tool registry', () => {
  it('exports all 12 tools', () => {
    expect(getToolNames()).toHaveLength(12);
  });

  it('returns metadata for known tools', () => {
    const meta = getToolMeta('memphis_journal');
    expect(meta).toBeDefined();
    expect(meta!.name).toBe('memphis_journal');
    expect(meta!.tier).toBe(0);
    expect(meta!.capabilities).toContain('write');
  });

  it('returns undefined for unknown tools', () => {
    expect(getToolMeta('nonexistent_tool')).toBeUndefined();
  });

  it('assigns tier 0 to core soul/journal tools', () => {
    const tier0Tools = [
      'memphis_journal',
      'memphis_recall',
      'memphis_decide',
      'memphis_health',
      'memphis_soul_read',
      'memphis_soul_write',
      'memphis_case_append',
      'memphis_case_query',
      'memphis_loop_step',
    ];
    for (const name of tier0Tools) {
      const meta = getToolMeta(name);
      expect(meta?.tier, `${name} should be tier 0`).toBe(0);
    }
  });

  it('assigns tier 1 to web_fetch', () => {
    expect(getToolMeta('memphis_web_fetch')?.tier).toBe(1);
  });

  it('assigns tier 2 to exec', () => {
    expect(getToolMeta('memphis_exec')?.tier).toBe(2);
  });

  it('getToolsByTier returns correct tools', () => {
    const tier0 = getToolsByTier(0);
    expect(tier0.length).toBe(9);
    expect(tier0.every((t) => t.tier === 0)).toBe(true);

    const tier1 = getToolsByTier(1);
    expect(tier1.length).toBe(1);
    expect(tier1[0].name).toBe('memphis_web_fetch');

    const tier2 = getToolsByTier(2);
    expect(tier2.length).toBe(2);
    expect(tier2.map((t) => t.name).sort()).toEqual(['memphis_exec', 'memphis_self_modify']);
  });

  it('every registry entry has a description', () => {
    for (const meta of Object.values(TOOL_REGISTRY)) {
      expect(meta.description.length).toBeGreaterThan(0);
    }
  });

  it('every registry entry has at least one capability', () => {
    for (const meta of Object.values(TOOL_REGISTRY)) {
      expect(meta.capabilities.length).toBeGreaterThan(0);
    }
  });
});
