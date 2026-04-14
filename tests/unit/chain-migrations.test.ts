import { mkdtempSync, rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runChainMigrations } from '../../src/infra/storage/migrations/runner.js';
import type { ChainMigration } from '../../src/infra/storage/migrations/types.js';

async function writeBlock(
  chainDir: string,
  index: number,
  block: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(chainDir, { recursive: true });
  const name = `${String(index).padStart(6, '0')}.json`;
  await fs.writeFile(join(chainDir, name), JSON.stringify(block), 'utf8');
}

describe('chain migration framework (Phase 3.2)', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'memphis-migrations-'));
  });

  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('no chains present → ok, no work', async () => {
    const result = await runChainMigrations({
      chainBaseDir: baseDir,
      rawEnv: {} as NodeJS.ProcessEnv,
    });
    expect(result.ok).toBe(true);
    expect(result.perChain).toEqual([]);
  });

  it('empty chain dir → skipped=empty-chain', async () => {
    await fs.mkdir(join(baseDir, 'memphis'), { recursive: true });
    const result = await runChainMigrations({
      chainBaseDir: baseDir,
      rawEnv: {} as NodeJS.ProcessEnv,
    });
    expect(result.perChain[0]!.skipped).toBe('empty-chain');
  });

  it('chain already at CURRENT_SCHEMA_VERSION → skipped=already-current', async () => {
    await writeBlock(join(baseDir, 'memphis'), 1, {
      index: 1,
      timestamp: '2026-04-14T00:00:00Z',
      chain: 'memphis',
      data: { content: 'hi' },
      prev_hash: '',
      hash: 'deadbeef',
      schemaVersion: 1,
    });
    const result = await runChainMigrations({
      chainBaseDir: baseDir,
      rawEnv: {} as NodeJS.ProcessEnv,
    });
    expect(result.perChain[0]!.skipped).toBe('already-current');
  });

  it('custom migration via override applies in dry-run without touching disk', async () => {
    await writeBlock(join(baseDir, 'memphis'), 1, {
      index: 1,
      timestamp: '2026-04-14T00:00:00Z',
      chain: 'memphis',
      data: { content: 'hi' },
      prev_hash: '',
      hash: 'deadbeef',
    });
    const fakeMigration: ChainMigration = {
      from: 1,
      to: 2,
      description: 'test migration',
      transformBlock: (b) => ({
        ...b,
        data: { ...b.data, migrated: true },
      }),
    };
    const result = await runChainMigrations({
      chainBaseDir: baseDir,
      rawEnv: {} as NodeJS.ProcessEnv,
      dryRun: true,
      migrationsOverride: [fakeMigration],
    });
    // Dry-run reports it would have migrated one block
    expect(result.dryRun).toBe(true);
    expect(result.perChain[0]!.blocksMigrated).toBe(1);

    // On-disk state unchanged
    const raw = await fs.readFile(
      join(baseDir, 'memphis', '000001.json'),
      'utf8',
    );
    const block = JSON.parse(raw);
    expect(block.data.migrated).toBeUndefined();
  });

  it('inconsistent schemaVersion within chain aborts with error', async () => {
    await writeBlock(join(baseDir, 'chain'), 1, {
      index: 1,
      timestamp: '2026-04-14T00:00:00Z',
      chain: 'chain',
      data: { content: 'a' },
      prev_hash: '',
      hash: 'h1',
    });
    await writeBlock(join(baseDir, 'chain'), 2, {
      index: 2,
      timestamp: '2026-04-14T00:00:01Z',
      chain: 'chain',
      data: { content: 'b' },
      prev_hash: 'h1',
      hash: 'h2',
      schemaVersion: 3, // inconsistent
    });
    const fakeMigration: ChainMigration = {
      from: 1,
      to: 2,
      description: 'test',
      transformBlock: (b) => b,
    };
    const result = await runChainMigrations({
      chainBaseDir: baseDir,
      rawEnv: {} as NodeJS.ProcessEnv,
      migrationsOverride: [fakeMigration],
    });
    expect(result.ok).toBe(false);
    expect(result.perChain[0]!.error).toMatch(/inconsistent schemaVersion/);
  });

  it('migration that throws aborts cleanly; on-disk untouched', async () => {
    await writeBlock(join(baseDir, 'chain'), 1, {
      index: 1,
      timestamp: '2026-04-14T00:00:00Z',
      chain: 'chain',
      data: { content: 'hi' },
      prev_hash: '',
      hash: 'h',
    });
    const fakeMigration: ChainMigration = {
      from: 1,
      to: 2,
      description: 'throws',
      transformBlock: () => {
        throw new Error('cannot migrate this block');
      },
    };
    const result = await runChainMigrations({
      chainBaseDir: baseDir,
      rawEnv: {} as NodeJS.ProcessEnv,
      migrationsOverride: [fakeMigration],
    });
    expect(result.ok).toBe(false);
    expect(result.perChain[0]!.error).toMatch(/cannot migrate this block/);

    // On-disk state unchanged
    const raw = await fs.readFile(
      join(baseDir, 'chain', '000001.json'),
      'utf8',
    );
    expect(JSON.parse(raw).schemaVersion).toBeUndefined();
  });

  it('v1→v2 end-to-end apply swaps dirs atomically', async () => {
    await writeBlock(join(baseDir, 'memphis'), 1, {
      index: 1,
      timestamp: '2026-04-14T00:00:00Z',
      chain: 'memphis',
      data: { content: 'alpha' },
      prev_hash: '',
      hash: 'h1',
    });
    await writeBlock(join(baseDir, 'memphis'), 2, {
      index: 2,
      timestamp: '2026-04-14T00:00:01Z',
      chain: 'memphis',
      data: { content: 'beta' },
      prev_hash: 'h1',
      hash: 'h2',
    });
    const fakeMigration: ChainMigration = {
      from: 1,
      to: 2,
      description: 'stamp schemaVersion explicitly',
      transformBlock: (b) => ({ ...b, data: { ...b.data, migrated: true } }),
    };
    // Override pushes target to v2; both blocks are v1 → runner migrates.
    const result = await runChainMigrations({
      chainBaseDir: baseDir,
      rawEnv: {} as NodeJS.ProcessEnv,
      dryRun: false,
      migrationsOverride: [fakeMigration],
    });
    expect(result.ok).toBe(true);
    expect(result.targetVersion).toBe(2);
    expect(result.perChain[0]!.blocksMigrated).toBe(2);

    // Active chain dir now has the migrated blocks
    const raw1 = JSON.parse(
      await fs.readFile(join(baseDir, 'memphis', '000001.json'), 'utf8'),
    );
    expect(raw1.data.migrated).toBe(true);
    expect(raw1.schemaVersion).toBe(2);

    // Backup dir exists alongside
    const entries = await fs.readdir(baseDir);
    expect(entries.some((e) => e.startsWith('memphis.pre-migration-'))).toBe(true);
  });
});
