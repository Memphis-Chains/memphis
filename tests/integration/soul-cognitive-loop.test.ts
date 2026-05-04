/**
 * Sprint J — Soul ↔ Cognitive autonomy loop round-trip pin.
 *
 * The "loop" the plan describes is the path from operator config →
 * soul manifest → cognitive surfaces → tool authorization. Sprint 1.1
 * (env override on every read) + S5-4 (rawEnv propagation in
 * tool-executor) already wired the loop end-to-end. This test makes
 * the contract explicit so future refactors that re-introduce the
 * 2026-04-27 confabulation gap (MEMPHIS_AUTONOMY_MODE=full set,
 * tool-executor still seeing 'balanced') get caught at PR time.
 *
 * Three round-trips covered:
 *   1. setCognitiveMode → file write → getCognitiveMode reads back.
 *   2. MEMPHIS_AUTONOMY_MODE env override flows through loadSoulManifest
 *      and reaches resolveToolPolicy on every read.
 *   3. On-disk manifest mode change persists across reads (no caching
 *      pinning the wrong value).
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveToolPolicy } from '../../src/gateway/authorization.js';
import {
  ensureSoulManifest,
  getCognitiveMode,
  loadSoulManifest,
  setCognitiveMode,
} from '../../src/soul/manifest.js';

interface Sandbox {
  dataDir: string;
  rawEnv: NodeJS.ProcessEnv;
}

function setup(): Sandbox {
  const dataDir = mkdtempSync(join(tmpdir(), 'memphis-soul-cog-loop-'));
  mkdirSync(join(dataDir, 'config'), { recursive: true });
  return {
    dataDir,
    rawEnv: {
      MEMPHIS_DATA_DIR: dataDir,
      // Seed a stable identity so manifest can be generated without
      // hitting vault init / DID prompts.
      HOME: dataDir,
    } as NodeJS.ProcessEnv,
  };
}

function tearDown(sb: Sandbox): void {
  rmSync(sb.dataDir, { recursive: true, force: true });
}

describe('soul ↔ cognitive autonomy loop', () => {
  let sb: Sandbox;

  beforeEach(() => {
    sb = setup();
    // Seed manifest with default mode.
    ensureSoulManifest(sb.rawEnv);
  });

  afterEach(() => {
    tearDown(sb);
  });

  it('setCognitiveMode round-trips through manifest file', () => {
    setCognitiveMode('B', sb.rawEnv);
    expect(getCognitiveMode(sb.rawEnv)).toBe('B');

    setCognitiveMode('E', sb.rawEnv);
    expect(getCognitiveMode(sb.rawEnv)).toBe('E');
  });

  it('MEMPHIS_AUTONOMY_MODE env override flows to manifest.mode on every load', () => {
    // Without override: manifest's on-disk mode wins (whatever
    // ensureSoulManifest seeded).
    const baseline = loadSoulManifest(sb.rawEnv);
    expect(baseline?.mode).toBeDefined();

    // With override: loadSoulManifest applies the override every time,
    // so consumers calling loadSoulManifest mid-process see the new
    // value without waiting for the next ensureSoulManifest write.
    const elevated = loadSoulManifest({ ...sb.rawEnv, MEMPHIS_AUTONOMY_MODE: 'full' });
    expect(elevated?.mode).toBe('full');

    // Reverting the env (i.e., a different process / surface without
    // override) reads the on-disk mode unchanged. Override is a
    // read-time decoration, not a persistent write.
    const reverted = loadSoulManifest(sb.rawEnv);
    expect(reverted?.mode).toBe(baseline?.mode);
  });

  it('manifest.mode reaches resolveToolPolicy for tool authorization', () => {
    // Closes the 2026-04-27 confabulation gap: set autonomy mode via
    // env, load manifest with that env, hand the manifest to
    // resolveToolPolicy, observe the mode actually gating policy.
    const elevatedManifest = loadSoulManifest({
      ...sb.rawEnv,
      MEMPHIS_AUTONOMY_MODE: 'full',
    });
    expect(elevatedManifest, 'manifest should load').not.toBeNull();

    // memphis_journal is tier 0 — even paranoid mode allows it after
    // require-approval, but full mode allows immediately.
    const journalPolicy = resolveToolPolicy({
      toolName: 'memphis_journal',
      manifest: elevatedManifest!,
    });
    expect(journalPolicy.policy).toBe('allow');

    // Sanity: paranoid manifest with same tool returns require-approval,
    // proving the resolver actually consults `manifest.mode`.
    const paranoidManifest = loadSoulManifest({
      ...sb.rawEnv,
      MEMPHIS_AUTONOMY_MODE: 'paranoid',
    });
    expect(paranoidManifest).not.toBeNull();
    const paranoidPolicy = resolveToolPolicy({
      toolName: 'memphis_journal',
      manifest: paranoidManifest!,
    });
    expect(paranoidPolicy.policy).toBe('require-approval');
  });

  it('cognitive mode change persists across loads (no caching pinning)', () => {
    // Read 1: seed to a known baseline so the test isn't tied to the
    // default cognitive mode of fresh manifests.
    setCognitiveMode('A', sb.rawEnv);
    expect(getCognitiveMode(sb.rawEnv)).toBe('A');

    // Read 2 after change: must reflect 'C', not return cached 'A'.
    setCognitiveMode('C', sb.rawEnv);
    expect(getCognitiveMode(sb.rawEnv)).toBe('C');

    // Read 3: cache shouldn't drift back to a stale read.
    expect(getCognitiveMode(sb.rawEnv)).toBe('C');
  });
});
