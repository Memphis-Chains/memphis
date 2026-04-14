import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getActiveSurfacesSnapshot,
  recordSurfaceActivity,
  resetSurfacePresence,
} from '../../src/core/surface-presence.js';
import {
  DEFAULT_TTS_DAILY_CHAT_LIMIT,
  checkTtsQuota,
  resetVoicePolicy,
} from '../../src/gateway/voice/voice-policy.js';
import {
  checkForUpdate,
  resetSelfUpdateCache,
} from '../../src/infra/self-update/github-release.js';
import {
  archiveGC,
  rotateChain,
  takeChainSnapshot,
} from '../../src/infra/storage/chain-rotation.js';

interface ChainEnv {
  dataDir: string;
  prevEnv: NodeJS.ProcessEnv;
}

function setupChainEnv(): ChainEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'memphis-p2-chain-'));
  const prevEnv = { ...process.env };
  process.env.MEMPHIS_DATA_DIR = dataDir;
  process.env.RUST_CHAIN_ENABLED = 'false';
  return { dataDir, prevEnv };
}

function tearDownChainEnv(env: ChainEnv): void {
  rmSync(env.dataDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in env.prevEnv)) delete process.env[key];
  }
  Object.assign(process.env, env.prevEnv);
}

function syntheticBlocks(chainDir: string, count: number, startIndex = 1): void {
  mkdirSync(chainDir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const idx = startIndex + i;
    writeFileSync(
      join(chainDir, `${String(idx).padStart(6, '0')}.json`),
      JSON.stringify({
        index: idx,
        timestamp: new Date().toISOString(),
        chain: 'syn',
        data: { content: `block-${idx}` },
        prev_hash: idx === 1 ? '' : '0'.repeat(64),
        hash: 'a'.repeat(64),
      }),
    );
  }
}

describe('archiveGC honors MEMPHIS_CHAIN_GC_KEEP_ARCHIVES', () => {
  let env: ChainEnv;

  beforeEach(() => {
    env = setupChainEnv();
  });

  afterEach(() => {
    tearDownChainEnv(env);
  });

  it('uses env value when no explicit gcKeep option supplied', async () => {
    const chain = 'env-keep';
    const chainDir = join(env.dataDir, 'chains', chain);
    syntheticBlocks(chainDir, 12);
    for (let r = 0; r < 5; r += 1) {
      await rotateChain(chain, { thresholdBytes: 1, minKeepBlocks: 2 });
      syntheticBlocks(chainDir, 4, 13 + r * 4);
    }
    process.env.MEMPHIS_CHAIN_GC_KEEP_ARCHIVES = '2';
    const result = await archiveGC(chain, { gcEnabled: true });
    expect(result.archivesScanned).toBeGreaterThanOrEqual(3);
    expect(result.keptArchives).toHaveLength(2);
  });

  it('explicit gcKeep option overrides env', async () => {
    const chain = 'opt-overrides-env';
    const chainDir = join(env.dataDir, 'chains', chain);
    syntheticBlocks(chainDir, 12);
    for (let r = 0; r < 4; r += 1) {
      await rotateChain(chain, { thresholdBytes: 1, minKeepBlocks: 2 });
      syntheticBlocks(chainDir, 4, 13 + r * 4);
    }
    process.env.MEMPHIS_CHAIN_GC_KEEP_ARCHIVES = '2';
    const result = await archiveGC(chain, { gcEnabled: true, gcKeep: 1 });
    expect(result.keptArchives).toHaveLength(1);
  });
});

describe('takeChainSnapshot honors MEMPHIS_CHAIN_SNAPSHOT_TAIL_BLOCKS', () => {
  let env: ChainEnv;

  beforeEach(() => {
    env = setupChainEnv();
  });

  afterEach(() => {
    tearDownChainEnv(env);
  });

  it('uses env value as default tail size when no option supplied', async () => {
    const chain = 'env-tail';
    const chainDir = join(env.dataDir, 'chains', chain);
    syntheticBlocks(chainDir, 50);
    process.env.MEMPHIS_CHAIN_SNAPSHOT_TAIL_BLOCKS = '5';
    try {
      const result = await takeChainSnapshot(chain);
      const snap = JSON.parse(readFileSync(result.snapshotPath, 'utf8')) as {
        tailLimit: number;
        tail: unknown[];
      };
      expect(snap.tailLimit).toBe(5);
      expect(snap.tail).toHaveLength(5);
      expect(result.blockCount).toBe(50);
    } finally {
      delete process.env.MEMPHIS_CHAIN_SNAPSHOT_TAIL_BLOCKS;
    }
  });
});

describe('self-update honors MEMPHIS_UPDATE_CACHE_TTL_MS and skips error caching', () => {
  beforeEach(() => {
    resetSelfUpdateCache();
  });

  it('uses env TTL when option not supplied', async () => {
    const fetchFn = vi.fn(async () =>
      Promise.resolve({ ok: true, status: 200, json: async () => ({ tag_name: 'v1.0.0' }) } as Response),
    ) as unknown as typeof fetch;
    await checkForUpdate('1.0.0', {
      fetchFn,
      nowMs: 1_000,
      rawEnv: { MEMPHIS_UPDATE_CACHE_TTL_MS: '120000' } as NodeJS.ProcessEnv,
    });
    // 60 s later, with the env TTL of 120 s, cache should still be hot
    await checkForUpdate('1.0.0', {
      fetchFn,
      nowMs: 61_000,
      rawEnv: { MEMPHIS_UPDATE_CACHE_TTL_MS: '120000' } as NodeJS.ProcessEnv,
    });
    expect((fetchFn as unknown as { mock: { calls: unknown[][] } }).mock.calls.length).toBe(1);
  });

  it('does not cache failed checks (transient errors retry next call)', async () => {
    let callCount = 0;
    const fetchFn = vi.fn(async () => {
      callCount += 1;
      return { ok: false, status: 503, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    await checkForUpdate('1.0.0', { fetchFn, nowMs: 1_000 });
    await checkForUpdate('1.0.0', { fetchFn, nowMs: 1_500 });
    await checkForUpdate('1.0.0', { fetchFn, nowMs: 2_000 });
    expect(callCount).toBe(3);
  });
});

describe('voice-policy uses Number() semantics, not parseInt', () => {
  beforeEach(() => {
    resetVoicePolicy();
  });

  it('reads MEMPHIS_TTS_DAILY_CHAT_LIMIT=1e2 as 100, not 1', () => {
    process.env.MEMPHIS_TTS_DAILY_CHAT_LIMIT = '1e2';
    try {
      const quota = checkTtsQuota('chat-1', process.env);
      expect(quota.limit).toBe(100);
    } finally {
      delete process.env.MEMPHIS_TTS_DAILY_CHAT_LIMIT;
    }
  });

  it('falls back to default for invalid values (regression check)', () => {
    process.env.MEMPHIS_TTS_DAILY_CHAT_LIMIT = 'not a number';
    try {
      const quota = checkTtsQuota('chat-1', process.env);
      expect(quota.limit).toBe(DEFAULT_TTS_DAILY_CHAT_LIMIT);
    } finally {
      delete process.env.MEMPHIS_TTS_DAILY_CHAT_LIMIT;
    }
  });
});

describe('surface-presence sets are bounded (cap = 256)', () => {
  beforeEach(() => {
    resetSurfacePresence();
  });

  it('actorIds set never exceeds the cap even after many distinct inserts', () => {
    for (let i = 0; i < 1000; i += 1) {
      recordSurfaceActivity({ surface: 'http', actorId: `ip-${i}`, tier: 2 });
    }
    const snap = getActiveSurfacesSnapshot();
    const http = snap.find((s) => s.surface === 'http');
    expect(http?.actorIds.length).toBeLessThanOrEqual(256);
    // Most-recent insertion must still be present (we drop oldest).
    expect(http?.actorIds.includes('ip-999')).toBe(true);
    // Earliest insertion should have been evicted.
    expect(http?.actorIds.includes('ip-0')).toBe(false);
  });
});
