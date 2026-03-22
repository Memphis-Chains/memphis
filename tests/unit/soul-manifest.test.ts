/**
 * Unit tests for soul manifest generation, loading, and persistence.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureSoulManifest,
  generateSoulManifest,
  loadSoulManifest,
  writeSoulManifest,
} from '../../src/soul/manifest.js';
import { soulManifestSchema } from '../../src/soul/types.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `memphis-soul-manifest-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('soul manifest', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dataDir = makeTmpDir();
    previousDataDir = process.env.MEMPHIS_DATA_DIR;
    process.env.MEMPHIS_DATA_DIR = dataDir;
    env = {
      ...process.env,
      MEMPHIS_DATA_DIR: dataDir,
      RUST_CHAIN_ENABLED: 'false',
    };
  });

  afterEach(() => {
    if (previousDataDir !== undefined) {
      process.env.MEMPHIS_DATA_DIR = previousDataDir;
    } else {
      delete process.env.MEMPHIS_DATA_DIR;
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('generates a manifest that passes Zod validation', () => {
    const manifest = generateSoulManifest(env);
    const parsed = soulManifestSchema.safeParse(manifest);
    expect(parsed.success).toBe(true);
  });

  it('populates identity from agent profile', () => {
    const manifest = generateSoulManifest(env);
    expect(manifest.identity.agentName).toBeTruthy();
    expect(manifest.identity.ownerName).toBeTruthy();
    expect(manifest.identity.runtimeMode).toBeTruthy();
    expect(manifest.identity.createdAt).toBeTruthy();
  });

  it('includes known tools in capabilities', () => {
    const manifest = generateSoulManifest(env);
    expect(manifest.capabilities.tools).toContain('memphis_journal');
    expect(manifest.capabilities.tools).toContain('memphis_soul_read');
    expect(manifest.capabilities.tools).toContain('memphis_soul_write');
    expect(manifest.capabilities.tools.length).toBeGreaterThanOrEqual(11);
  });

  it('includes known chains and channels', () => {
    const manifest = generateSoulManifest(env);
    expect(manifest.capabilities.chains).toContain('journal');
    expect(manifest.capabilities.chains).toContain('cases');
    expect(manifest.capabilities.channels).toContain('cli');
    expect(manifest.capabilities.channels).toContain('mcp');
  });

  it('includes boundary tiers', () => {
    const manifest = generateSoulManifest(env);
    expect(manifest.boundaries.tier0.auth).toBe('none');
    expect(manifest.boundaries.tier1.auth).toBe('api_token');
    expect(manifest.boundaries.tier2.auth).toBe('vault_passphrase');
  });

  it('writes and loads manifest from disk', () => {
    const manifest = generateSoulManifest(env);
    writeSoulManifest(manifest, env);
    const loaded = loadSoulManifest(env);
    expect(loaded).not.toBeNull();
    expect(loaded!.identity.agentName).toBe(manifest.identity.agentName);
    expect(loaded!.schemaVersion).toBe(manifest.schemaVersion);
  });

  it('loadSoulManifest returns null when file does not exist', () => {
    // Use a fresh empty dir — no manifest written yet
    const emptyDir = makeTmpDir();
    process.env.MEMPHIS_DATA_DIR = emptyDir;
    try {
      const loaded = loadSoulManifest(env);
      expect(loaded).toBeNull();
    } finally {
      process.env.MEMPHIS_DATA_DIR = dataDir;
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('loadSoulManifest returns null for invalid JSON', () => {
    const manifest = generateSoulManifest(env);
    writeSoulManifest(manifest, env);

    // Find and corrupt the manifest file
    const configDir = join(dataDir, 'config');
    const manifestPath = join(configDir, 'soul-manifest.json');
    if (existsSync(manifestPath)) {
      writeFileSync(manifestPath, '{ invalid json }}}', 'utf8');
    }
    const loaded = loadSoulManifest(env);
    expect(loaded).toBeNull();
  });

  it('ensureSoulManifest preserves createdAt from existing manifest', async () => {
    const first = ensureSoulManifest(env);
    const originalCreatedAt = first.identity.createdAt;

    // Wait to ensure timestamp difference
    await new Promise((r) => setTimeout(r, 10));

    const second = ensureSoulManifest(env);
    expect(second.identity.createdAt).toBe(originalCreatedAt);
    // generatedAt should differ since we waited
    expect(new Date(second.generatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.generatedAt).getTime(),
    );
  });

  it('ensureSoulManifest preserves DID from existing manifest', () => {
    ensureSoulManifest(env);

    // Manually set a DID on the written manifest
    const configDir = join(dataDir, 'config');
    const manifestPath = join(configDir, 'soul-manifest.json');
    expect(existsSync(manifestPath)).toBe(true);

    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    raw.identity.did = 'did:key:test123';
    writeFileSync(manifestPath, JSON.stringify(raw, null, 2), 'utf8');

    const second = ensureSoulManifest(env);
    expect(second.identity.did).toBe('did:key:test123');
  });
});
