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
  it('exports all registered tools', () => {
    // Codex Round 5 P1 fix (#107): added 2 tier-2 mutating tools to
    // TOOL_REGISTRY (memphis_config_set, memphis_cognitive_mode_set).
    expect(getToolNames()).toHaveLength(34);
  });

  it('hides experimental preview tools by default', () => {
    expect(getToolNames()).not.toContain('memphis_chain_query');
    expect(getToolNames()).not.toContain('memphis_providers');
    expect(getToolNames()).not.toContain('memphis_system_info');
  });

  it('exposes experimental preview tools when MEMPHIS_FEATURES enables them', () => {
    const names = getToolNames({ MEMPHIS_FEATURES: 'experimental-tools' });
    expect(names).toContain('memphis_chain_query');
    expect(names).toContain('memphis_providers');
    expect(names).toContain('memphis_system_info');
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
      'memphis_search',
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

  it('assigns tier 2 to web_fetch', () => {
    expect(getToolMeta('memphis_web_fetch')?.tier).toBe(2);
  });

  it('assigns tier 2 to exec', () => {
    expect(getToolMeta('memphis_exec')?.tier).toBe(2);
  });

  it('getToolsByTier returns correct tools', () => {
    const tier0 = getToolsByTier(0);
    expect(tier0.length).toBe(13);
    expect(tier0.every((t) => t.tier === 0)).toBe(true);

    const tier1 = getToolsByTier(1);
    expect(tier1.length).toBe(1);
    expect(tier1.map((t) => t.name).sort()).toEqual(['memphis_health_check'].sort());

    const tier2 = getToolsByTier(2);
    expect(tier2.length).toBe(20);
    expect(tier2.map((t) => t.name).sort()).toEqual(
      [
        'memphis_build',
        'memphis_code_read',
        // Codex Round 5 P1 fix (#107): added to TOOL_REGISTRY so MCP can
        // actually register them — the schema layer was registering
        // them but isToolEnabledByFeatureFlag rejected them silently.
        'memphis_cognitive_mode_set',
        'memphis_config_reload',
        'memphis_config_set',
        'memphis_cron',
        'memphis_db',
        'memphis_deploy',
        'memphis_exec',
        'memphis_fs_ops',
        'memphis_fs_write',
        'memphis_git',
        'memphis_glob',
        'memphis_grep',
        'memphis_package',
        'memphis_restart',
        'memphis_self_modify',
        'memphis_test',
        'memphis_web_fetch',
        'memphis_web_search',
      ].sort(),
    );
  });

  it('getToolsByTier includes preview tier-0 tools when the feature flag is enabled', () => {
    const tier0 = getToolsByTier(0, { MEMPHIS_FEATURES: 'experimental' });
    const names = tier0.map((tool) => tool.name);

    expect(names).toContain('memphis_chain_query');
    expect(names).toContain('memphis_providers');
    expect(names).toContain('memphis_system_info');
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
