/**
 * Sprint 1.1 — verify loadSoulManifest applies MEMPHIS_AUTONOMY_MODE env
 * override on read, matching the existing write-side behaviour in
 * ensureSoulManifest. Without this, tier-3 elevation flips the env var but
 * resolveToolPolicy keeps reading the on-disk mode (typically 'balanced')
 * because tool-executor reads via loadSoulManifest, not ensureSoulManifest.
 *
 * 4-variant matrix covering the cross-product of (disk mode, env override).
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureSoulManifest,
  loadSoulManifest,
  writeSoulManifest,
} from '../../src/soul/manifest.js';
import type { AutonomyMode } from '../../src/soul/types.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `memphis-soul-env-override-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('loadSoulManifest — env override (sprint 1.1)', () => {
  let dataDir: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    dataDir = makeTmpDir();
    process.env.MEMPHIS_DATA_DIR = dataDir;
    delete process.env.MEMPHIS_AUTONOMY_MODE;
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  function seedManifestOnDisk(diskMode: AutonomyMode): void {
    const fresh = ensureSoulManifest(process.env);
    fresh.mode = diskMode;
    writeSoulManifest(fresh, process.env);
  }

  it('A. disk=balanced, env=full → load returns full', () => {
    seedManifestOnDisk('balanced');
    process.env.MEMPHIS_AUTONOMY_MODE = 'full';
    const loaded = loadSoulManifest(process.env);
    expect(loaded?.mode).toBe('full');
  });

  it('B. disk=full, env=balanced → load returns balanced', () => {
    seedManifestOnDisk('full');
    process.env.MEMPHIS_AUTONOMY_MODE = 'balanced';
    const loaded = loadSoulManifest(process.env);
    expect(loaded?.mode).toBe('balanced');
  });

  it('C. disk=quiet, env=paranoid → load returns paranoid', () => {
    seedManifestOnDisk('quiet');
    process.env.MEMPHIS_AUTONOMY_MODE = 'paranoid';
    const loaded = loadSoulManifest(process.env);
    expect(loaded?.mode).toBe('paranoid');
  });

  it('D. disk=balanced, env unset → load returns balanced (no override applied)', () => {
    seedManifestOnDisk('balanced');
    delete process.env.MEMPHIS_AUTONOMY_MODE;
    const loaded = loadSoulManifest(process.env);
    expect(loaded?.mode).toBe('balanced');
  });

  it('E. invalid env value falls back to disk mode (parse safe)', () => {
    seedManifestOnDisk('balanced');
    process.env.MEMPHIS_AUTONOMY_MODE = 'not-a-real-mode';
    const loaded = loadSoulManifest(process.env);
    expect(loaded?.mode).toBe('balanced');
  });

  it('F. empty string env value treated as unset', () => {
    seedManifestOnDisk('full');
    process.env.MEMPHIS_AUTONOMY_MODE = '';
    const loaded = loadSoulManifest(process.env);
    expect(loaded?.mode).toBe('full');
  });

  it('uses the explicit rawEnv argument over process.env', () => {
    seedManifestOnDisk('balanced');
    process.env.MEMPHIS_AUTONOMY_MODE = 'paranoid';
    const explicit = { ...process.env, MEMPHIS_AUTONOMY_MODE: 'full' };
    const loaded = loadSoulManifest(explicit);
    expect(loaded?.mode).toBe('full');
  });

  it('returns null when no manifest file exists (regardless of env)', () => {
    process.env.MEMPHIS_AUTONOMY_MODE = 'full';
    const loaded = loadSoulManifest(process.env);
    expect(loaded).toBeNull();
  });
});
