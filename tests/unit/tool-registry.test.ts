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

const stableEnv: NodeJS.ProcessEnv = {};

describe('tool registry', () => {
  it('exports all registered tools', () => {
    // Codex Round 5 P1 fix (#107): added 2 tier-2 mutating tools to
    // TOOL_REGISTRY (memphis_config_set, memphis_cognitive_mode_set).
    // S3 (sprint 2026-04-26): added memphis_self_describe (tier 0, read).
    // Track C3 (2026-04-29): added memphis_slo_status (tier 0, read).
    // PR #486 (2026-05-05): added memphis_brave_search (tier 2, read+network).
    // PR #497 (2026-05-05): added memphis_media_ingest (tier 2, read+write+network).
    // PR #572 (2026-05-12): added memphis_skill_{list,show,create,validate,install}
    //   — 5 first-class skill tools (3 tier-1 read, 2 tier-2 write).
    // PR (2026-05-12, kartograf-runtime): added memphis_kartograf (tier-1 read)
    //   — wraps the new OnnxKartografSession singleton.
    // PR #593 (S5 self-coding loop): added 7 plan-aware self-coding tools —
    //   memphis_self_plan_{create,get,advance,cancel} (4 tier-0),
    //   memphis_self_review (tier-0 read),
    //   memphis_self_pr_open (tier-2 execute+network),
    //   memphis_self_deploy_verify (tier-0 read+execute).
    // REV2 Temat 3.5: +1 tier-1 read — memphis_exec_analyze (pre-exec
    // impact analyzer; companion to memphis_exec for wisdom doctrine).
    // 2026-06-16: +2 tier-0 read — memphis_self_governance_status
    // (canonical supervised-operational autonomy readiness) and
    // memphis_tensor_status (canonical tensor/vector runtime truth).
    expect(getToolNames(stableEnv)).toHaveLength(55);
  });

  it('hides experimental preview tools by default', () => {
    const names = getToolNames(stableEnv);
    expect(names).not.toContain('memphis_chain_query');
    expect(names).not.toContain('memphis_providers');
    expect(names).not.toContain('memphis_system_info');
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
      'memphis_lr_dashboard',
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
    const tier0 = getToolsByTier(0, stableEnv);
    // 15 = 13 base tier-0 + memphis_self_describe (S3, sprint 2026-04-26)
    //      + memphis_slo_status (Track C3, 2026-04-29)
    // PR #593 (S5): +6 tier-0 — memphis_self_plan_{create,get,advance,cancel}
    //   + memphis_self_review + memphis_self_deploy_verify.
    // 2026-06-16: +2 tier-0 — memphis_self_governance_status + memphis_tensor_status.
    expect(tier0.length).toBe(24);
    expect(tier0.every((t) => t.tier === 0)).toBe(true);

    const tier1 = getToolsByTier(1, stableEnv);
    // PR #572 (2026-05-12): added 3 tier-1 read tools — memphis_skill_list,
    // memphis_skill_show, memphis_skill_validate (info-only operations).
    // PR (kartograf-runtime, 2026-05-12): added memphis_kartograf (inference,
    // read-only — returns embedding + zones, no chain writes).
    // REV2 Temat 3.5: +1 tier-1 read — memphis_exec_analyze.
    expect(tier1.length).toBe(6);
    expect(tier1.map((t) => t.name).sort()).toEqual(
      [
        'memphis_exec_analyze',
        'memphis_health_check',
        'memphis_kartograf',
        'memphis_skill_list',
        'memphis_skill_show',
        'memphis_skill_validate',
      ].sort(),
    );

    const tier2 = getToolsByTier(2, stableEnv);
    // PR #572 (2026-05-12): added 2 tier-2 write tools —
    // memphis_skill_create, memphis_skill_install (write to drafts/installed dirs).
    // PR #593 (S5): +1 tier-2 — memphis_self_pr_open (execute+network,
    // pushes branch + opens PR via gh).
    expect(tier2.length).toBe(25);
    expect(tier2.map((t) => t.name).sort()).toEqual(
      [
        'memphis_brave_search',
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
        'memphis_media_ingest',
        'memphis_package',
        'memphis_restart',
        'memphis_self_modify',
        'memphis_self_pr_open',
        'memphis_skill_create',
        'memphis_skill_install',
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
