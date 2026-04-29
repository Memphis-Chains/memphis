import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendBlock, verifyChainIntegrity } from '../../src/infra/storage/chain-adapter.js';
import {
  archiveGC,
  rotateChain,
  takeChainSnapshot,
} from '../../src/infra/storage/chain-rotation.js';
import { runCli } from '../helpers/cli.js';

interface TestEnv {
  dataDir: string;
  prevEnv: NodeJS.ProcessEnv;
}

function setupEnv(): TestEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'memphis-chain-it-'));
  const prevEnv = { ...process.env };
  process.env.MEMPHIS_DATA_DIR = dataDir;
  process.env.RUST_CHAIN_ENABLED = 'false';
  return { dataDir, prevEnv };
}

function tearDown(env: TestEnv): void {
  rmSync(env.dataDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in env.prevEnv)) delete process.env[key];
  }
  Object.assign(process.env, env.prevEnv);
}

/**
 * Synthesize on-disk blocks without invoking `appendBlock` — bypasses the
 * pre-append integrity check so we can simulate a chain that has already
 * been partially archived (genesis no longer present in active dir).
 */
function syntheticBlocks(chainDir: string, count: number, startIndex = 1): void {
  mkdirSync(chainDir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const idx = startIndex + i;
    const block = {
      index: idx,
      timestamp: new Date().toISOString(),
      chain: 'synthetic',
      data: { content: `block-${idx}` },
      prev_hash: idx === 1 ? '' : '0'.repeat(64),
      hash: 'a'.repeat(64),
    };
    writeFileSync(
      join(chainDir, `${String(idx).padStart(6, '0')}.json`),
      JSON.stringify(block, null, 2),
    );
  }
}

describe('verifyChainIntegrity — tampering detection', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    tearDown(env);
  });

  it('detects when a block file has been tampered with (hash mismatch)', async () => {
    const chain = 'tamper-test';
    for (let i = 0; i < 5; i += 1) {
      await appendBlock(chain, { type: 'note', content: `block-${i}` }, process.env);
    }

    const chainDir = join(env.dataDir, 'chains', chain);
    const files = readdirSync(chainDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);

    const target = files.sort()[2]!;
    const fullPath = join(chainDir, target);
    const original = JSON.parse(readFileSync(fullPath, 'utf8')) as Record<string, unknown>;
    const dataObj = original.data as Record<string, unknown>;
    dataObj.content = 'tampered-content-zzz';
    writeFileSync(fullPath, JSON.stringify(original));

    await expect(verifyChainIntegrity(chain)).rejects.toThrow(/hash mismatch/);
  });

  it('passes for an unmodified chain', async () => {
    const chain = 'clean-test';
    for (let i = 0; i < 4; i += 1) {
      await appendBlock(chain, { type: 'note', content: `block-${i}` }, process.env);
    }
    const result = await verifyChainIntegrity(chain);
    expect(result.ok).toBe(true);
    expect(result.blockCount).toBe(4);
  });
});

describe('archiveGC', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    tearDown(env);
  });

  it('is a no-op when MEMPHIS_CHAIN_GC_ENABLED is unset (default false)', async () => {
    const chain = 'gc-disabled';
    const chainDir = join(env.dataDir, 'chains', chain);
    syntheticBlocks(chainDir, 12);

    for (let r = 0; r < 4; r += 1) {
      await rotateChain(chain, { thresholdBytes: 1, minKeepBlocks: 2 });
      syntheticBlocks(chainDir, 4, 13 + r * 4);
    }
    const result = await archiveGC(chain, { gcKeep: 1 });
    expect(result.enabled).toBe(false);
    expect(result.archivesDeleted).toBe(0);
    expect(result.archivesScanned).toBeGreaterThanOrEqual(1);
  });

  it('keeps the most-recent N archives and deletes the rest when enabled', async () => {
    const chain = 'gc-enabled';
    const chainDir = join(env.dataDir, 'chains', chain);
    syntheticBlocks(chainDir, 12);
    for (let r = 0; r < 5; r += 1) {
      await rotateChain(chain, { thresholdBytes: 1, minKeepBlocks: 2 });
      syntheticBlocks(chainDir, 4, 13 + r * 4);
    }
    const beforeArchives = readdirSync(join(env.dataDir, 'chains', '.archives')).filter((f) =>
      f.startsWith(`${chain}_`),
    );
    expect(beforeArchives.length).toBeGreaterThanOrEqual(3);

    const result = await archiveGC(chain, { gcEnabled: true, gcKeep: 2 });
    expect(result.enabled).toBe(true);
    expect(result.archivesDeleted).toBe(beforeArchives.length - 2);

    const remaining = readdirSync(join(env.dataDir, 'chains', '.archives')).filter((f) =>
      f.startsWith(`${chain}_`),
    );
    expect(remaining.length).toBe(2);
  });

  it('returns zero deletions when archives count is at or below keep limit', async () => {
    const chain = 'under-limit';
    const chainDir = join(env.dataDir, 'chains', chain);
    syntheticBlocks(chainDir, 12);
    await rotateChain(chain, { thresholdBytes: 1, minKeepBlocks: 2 });
    const result = await archiveGC(chain, { gcEnabled: true, gcKeep: 8 });
    expect(result.archivesDeleted).toBe(0);
    expect(result.keptArchives.length).toBeLessThanOrEqual(8);
  });
});

describe('takeChainSnapshot', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    tearDown(env);
  });

  it('writes a snapshot JSON with chain head + tail blocks', async () => {
    const chain = 'snap-test';
    const chainDir = join(env.dataDir, 'chains', chain);
    syntheticBlocks(chainDir, 6);

    const snapshotDir = join(env.dataDir, 'chain-snapshots');
    const result = await takeChainSnapshot(chain, { snapshotTailBlocks: 4 });
    expect(result.snapshotPath).toMatch(/snapshot-\d+\.json$/);
    expect(result.blockCount).toBe(6);

    const snap = JSON.parse(readFileSync(result.snapshotPath, 'utf8')) as {
      chain: string;
      tailLimit: number;
      tail: Array<Record<string, unknown>>;
      head: Record<string, unknown> | null;
      schemaVersion: number;
    };
    expect(snap.chain).toBe(chain);
    expect(snap.tailLimit).toBe(4);
    expect(snap.tail).toHaveLength(4);
    expect(snap.head).not.toBeNull();
    expect(snap.schemaVersion).toBe(1);

    const filesInSnapDir = readdirSync(snapshotDir).filter((f) => /^snapshot-\d+\.json$/.test(f));
    expect(filesInSnapDir.length).toBeGreaterThanOrEqual(1);
  });

  it('caps tail to the requested limit but preserves total blockCount', async () => {
    const chain = 'snap-cap';
    const chainDir = join(env.dataDir, 'chains', chain);
    syntheticBlocks(chainDir, 3);
    const result = await takeChainSnapshot(chain, { snapshotTailBlocks: 1000 });
    const snap = JSON.parse(readFileSync(result.snapshotPath, 'utf8')) as {
      tail: unknown[];
      blockCount: number;
    };
    expect(snap.tail).toHaveLength(3);
    expect(snap.blockCount).toBe(3);
  });
});

describe('rotateChain — snapshot + GC integration', () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupEnv();
  });

  afterEach(() => {
    tearDown(env);
  });

  it('writes a snapshot before archiving when snapshots are enabled', async () => {
    const chain = 'snap-rotate';
    const chainDir = join(env.dataDir, 'chains', chain);
    syntheticBlocks(chainDir, 12);
    const snapshotDir = join(env.dataDir, 'chain-snapshots');
    const before = (() => {
      try {
        return readdirSync(snapshotDir).length;
      } catch {
        return 0;
      }
    })();
    const result = await rotateChain(chain, { thresholdBytes: 1, minKeepBlocks: 2 });
    expect(result.rotated).toBe(true);
    const after = readdirSync(snapshotDir).filter((f) => /^snapshot-\d+\.json$/.test(f));
    expect(after.length).toBe(before + 1);
  });

  it('three rotations with GC enabled keep exactly N archives', async () => {
    const chain = 'three-rot';
    const chainDir = join(env.dataDir, 'chains', chain);
    syntheticBlocks(chainDir, 20);
    for (let r = 0; r < 3; r += 1) {
      await rotateChain(chain, {
        thresholdBytes: 1,
        minKeepBlocks: 2,
        gcEnabled: true,
        gcKeep: 1,
      });
      syntheticBlocks(chainDir, 6, 21 + r * 6);
    }
    const archives = readdirSync(join(env.dataDir, 'chains', '.archives')).filter((f) =>
      f.startsWith(`${chain}_`),
    );
    expect(archives.length).toBe(1);
  });

  it('respects MEMPHIS_CHAIN_SNAPSHOT_ON_ROTATION=false', async () => {
    const chain = 'no-snap';
    const chainDir = join(env.dataDir, 'chains', chain);
    syntheticBlocks(chainDir, 12);
    const snapshotDir = join(env.dataDir, 'chain-snapshots');
    const before = (() => {
      try {
        return readdirSync(snapshotDir).length;
      } catch {
        return 0;
      }
    })();
    process.env.MEMPHIS_CHAIN_SNAPSHOT_ON_ROTATION = 'false';
    try {
      await rotateChain(chain, { thresholdBytes: 1, minKeepBlocks: 2 });
    } finally {
      delete process.env.MEMPHIS_CHAIN_SNAPSHOT_ON_ROTATION;
    }
    const after = (() => {
      try {
        return readdirSync(snapshotDir).filter((f) => /^snapshot-\d+\.json$/.test(f)).length;
      } catch {
        return 0;
      }
    })();
    expect(after).toBe(before);
  });
});

describe('security: chain integrity verification', () => {
  const originalHome = process.env.HOME;

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  });

  it('verifies linked prev_hash across blocks', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memphis-chain-verify-'));
    process.env.HOME = home;

    await appendBlock(
      'journal',
      { type: 'journal', content: 'one' },
      { RUST_CHAIN_ENABLED: 'false' },
    );
    await appendBlock(
      'journal',
      { type: 'journal', content: 'two' },
      { RUST_CHAIN_ENABLED: 'false' },
    );

    const result = await verifyChainIntegrity('journal');
    expect(result.ok).toBe(true);
    expect(result.blockCount).toBe(2);
  });

  it('detects tampering when prev_hash link is broken', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memphis-chain-verify-'));
    process.env.HOME = home;

    await appendBlock(
      'journal',
      { type: 'journal', content: 'one' },
      { RUST_CHAIN_ENABLED: 'false' },
    );
    await appendBlock(
      'journal',
      { type: 'journal', content: 'two' },
      { RUST_CHAIN_ENABLED: 'false' },
    );

    const chainDir = join(home, '.memphis', 'chains', 'journal');
    const secondPath = join(chainDir, '000002.json');
    const second = JSON.parse(readFileSync(secondPath, 'utf8')) as { prev_hash: string };
    second.prev_hash = 'f'.repeat(64);
    writeFileSync(secondPath, JSON.stringify(second, null, 2), 'utf8');

    await expect(verifyChainIntegrity('journal')).rejects.toThrow(/chain integrity check failed/);
  });

  it('exposes CLI command: memphis chain verify', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memphis-chain-cli-'));
    process.env.HOME = home;
    await appendBlock(
      'journal',
      { type: 'journal', content: 'cli-check' },
      { RUST_CHAIN_ENABLED: 'false' },
    );

    const out = await runCli(['chain', 'verify', '--chain', 'journal', '--json'], {
      env: { HOME: home },
    });

    const parsed = JSON.parse(out) as { ok: boolean; chain?: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.chain).toBe('journal');
  });
});
