/**
 * Unit tests for `runMemphisSelfDescribe`.
 *
 * Pin the contract surfaced after the 2026-04-26 operator session: the bot
 * stops hallucinating its capabilities by reading runtime state through this
 * helper instead.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { runMemphisSelfDescribe } from '../../src/mcp/tools/self-describe.js';
import {
  __resetTier3SessionsForTests,
  __seedTier3SessionForTests,
} from '../../src/security/tier3-session.js';

afterEach(() => {
  __resetTier3SessionsForTests();
});

describe('runMemphisSelfDescribe', () => {
  it('returns surface, policy, cognitive mode, tools and registered count for default surface', async () => {
    const out = await runMemphisSelfDescribe({}, { MEMPHIS_DATA_DIR: '/tmp/memphis-test' } as NodeJS.ProcessEnv);

    expect(out.surface).toBe('mcp');
    expect(typeof out.surfacePolicy.maxToolTier).toBe('number');
    expect(['A', 'B', 'C', 'D', 'E']).toContain(out.cognitive.mode);
    expect(out.toolsRegistered).toBeGreaterThan(0);
    expect(out.tools.length).toBe(out.toolsRegistered);
    // memphis_self_describe is itself in the registry
    expect(out.tools.some((t) => t.name === 'memphis_self_describe')).toBe(true);
  });

  it('marks tools as available iff their tier is <= surface policy maxToolTier', async () => {
    const out = await runMemphisSelfDescribe(
      { surface: 'telegram' },
      {
        MEMPHIS_DATA_DIR: '/tmp/memphis-test',
        MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER: '0',
      } as NodeJS.ProcessEnv,
    );
    expect(out.surfacePolicy.maxToolTier).toBe(0);
    const tier0Tools = out.tools.filter((t) => t.tier === 0);
    const tier2Tools = out.tools.filter((t) => t.tier === 2);
    // Tier 0 tools should be available; tier 2 should not.
    expect(tier0Tools.every((t) => t.available)).toBe(true);
    if (tier2Tools.length > 0) {
      expect(tier2Tools.every((t) => !t.available)).toBe(true);
    }
  });

  it('reports active tier-3 session for the resolved (surface, actorId) pair', async () => {
    __seedTier3SessionForTests('telegram', '1316033647');
    const out = await runMemphisSelfDescribe(
      { surface: 'telegram', actorId: '1316033647' },
      { MEMPHIS_DATA_DIR: '/tmp/memphis-test' } as NodeJS.ProcessEnv,
    );

    expect(out.effectiveTier).toBe(3);
    expect(out.tier3Session).not.toBeNull();
    expect(out.tier3Session!.surface).toBe('telegram');
    expect(out.tier3Session!.actorId).toBe('1316033647');
    expect(out.tier3Session!.remainingMs).toBeGreaterThan(0);
  });

  it('lists tier-3 sessions across surfaces in activeTier3SessionsAcrossSurfaces', async () => {
    __seedTier3SessionForTests('tui', 'local');
    __seedTier3SessionForTests('telegram', '42');
    const out = await runMemphisSelfDescribe({}, { MEMPHIS_DATA_DIR: '/tmp/memphis-test' } as NodeJS.ProcessEnv);

    expect(out.activeTier3SessionsAcrossSurfaces).toHaveLength(2);
    const surfaces = out.activeTier3SessionsAcrossSurfaces.map((s) => s.surface).sort();
    expect(surfaces).toEqual(['telegram', 'tui']);
  });

  it('reflects MEMPHIS_FEATURES env var in featureFlags', async () => {
    const out = await runMemphisSelfDescribe(
      {},
      {
        MEMPHIS_DATA_DIR: '/tmp/memphis-test',
        MEMPHIS_FEATURES: 'experimental-tools',
      } as NodeJS.ProcessEnv,
    );
    expect(out.featureFlags).toContain('experimental-tools');
  });

  it('emits ISO timestamps for asOf and tier3 session timestamps', async () => {
    __seedTier3SessionForTests('cli', 'local');
    const out = await runMemphisSelfDescribe(
      { surface: 'cli', actorId: 'local' },
      { MEMPHIS_DATA_DIR: '/tmp/memphis-test' } as NodeJS.ProcessEnv,
    );
    expect(out.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.tier3Session!.grantedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(out.tier3Session!.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('propagates helpText + cliFlags from tool-registry through capabilities envelope (Sprint E Phase 2)', async () => {
    // Pin the wiring: tools that have helpText / cliFlags in
    // src/gateway/tool-registry.ts (Sprint E Phase 1 proof set)
    // surface those fields through `runMemphisSelfDescribe` so CLI
    // `memphis tools describe`, future TUI `?` overlay, and Telegram
    // `/help <tool>` all see the same rich text.
    const out = await runMemphisSelfDescribe(
      {},
      { MEMPHIS_DATA_DIR: '/tmp/memphis-test' } as NodeJS.ProcessEnv,
    );
    const journal = out.tools.find((t) => t.name === 'memphis_journal');
    expect(journal, 'memphis_journal must be in tools[]').toBeDefined();
    expect(journal!.helpText, 'memphis_journal has Phase 1 helpText').toBeDefined();
    expect(journal!.helpText!.length).toBeGreaterThan(journal!.description.length);
    expect(Array.isArray(journal!.cliFlags), 'cliFlags is array when present').toBe(true);
    expect(journal!.cliFlags!.length).toBeGreaterThan(0);

    // Sprint E Phase 3 batch 5 closes proof-set coverage — every tool
    // now ships helpText + cliFlags, so we can't observe the unmigrated
    // shape organically anymore. Pin the durable invariant instead: the
    // capabilities envelope surfaces helpText as a string (when present)
    // and cliFlags as an array (when present), never coerced to empty
    // string / null. The undefined-fallback path is exercised via
    // tool-registry-descriptors.test.ts using a synthesized stripped
    // meta — the surface contract here is what matters.
    for (const tool of out.tools) {
      if (tool.helpText !== undefined) {
        expect(typeof tool.helpText, `${tool.name} helpText must be string`).toBe('string');
        expect(tool.helpText.length, `${tool.name} helpText must be non-empty`).toBeGreaterThan(0);
      }
      if (tool.cliFlags !== undefined) {
        expect(Array.isArray(tool.cliFlags), `${tool.name} cliFlags must be array`).toBe(true);
      }
    }
  });

  // PR #489 — recentConfigChanges field. Pin the contract: shape is
  // always an array (empty is fine), and when entries exist they
  // surface capability tag + summary + ISO timestamp + block index.
  it('returns recentConfigChanges as an array (empty when no journal blocks tagged config-change)', async () => {
    const out = await runMemphisSelfDescribe(
      {},
      { MEMPHIS_DATA_DIR: '/tmp/memphis-self-describe-no-config' } as NodeJS.ProcessEnv,
    );
    expect(Array.isArray(out.recentConfigChanges)).toBe(true);
    // Tmpdir has no journal chain → expect empty
    expect(out.recentConfigChanges).toHaveLength(0);
  });

  it('shape contract for recentConfigChanges entries (tested via type — empty array is fine)', async () => {
    // We don't seed real chain data here (would require rust adapter
    // setup). Instead pin the field shape so future refactors don't
    // accidentally drop properties downstream consumers (system
    // prompt, doctor, TUI) read.
    const out = await runMemphisSelfDescribe(
      {},
      { MEMPHIS_DATA_DIR: '/tmp/memphis-self-describe-shape' } as NodeJS.ProcessEnv,
    );
    expect(out).toHaveProperty('recentConfigChanges');
    // TypeScript compile guarantees the shape; runtime assertion
    // catches accidental any-typing or rename of the field.
    for (const entry of out.recentConfigChanges) {
      expect(typeof entry.timestamp).toBe('string');
      expect(typeof entry.capability).toBe('string');
      expect(typeof entry.blockIndex).toBe('number');
      expect(typeof entry.summary).toBe('string');
      expect(Array.isArray(entry.tags)).toBe(true);
    }
  });
});
