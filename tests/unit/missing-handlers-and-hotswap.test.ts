import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPostApplyHooks } from '../../src/infra/config/post-apply-hooks.js';
import { RateLimiter, globalLimiter, sensitiveLimiter } from '../../src/infra/http/rate-limit.js';

interface ChainEnv {
  dataDir: string;
  prevEnv: NodeJS.ProcessEnv;
}

function setupChainEnv(): ChainEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'memphis-nice-'));
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

describe('chain diagnose handler', () => {
  let env: ChainEnv;

  beforeEach(() => {
    env = setupChainEnv();
  });

  afterEach(() => {
    tearDownChainEnv(env);
  });

  it('reports zero mismatches on an empty chain dir', async () => {
    const chain = 'empty';
    mkdirSync(join(env.dataDir, 'chains', chain), { recursive: true });
    const { diagnoseChainHashes } = await import('../../src/infra/storage/chain-adapter.js');
    const result = await diagnoseChainHashes(chain);
    expect(result.mismatches).toBe(0);
    expect(result.totalBlocks).toBe(0);
  });

  it('reports a mismatch when a block hash has been tampered', async () => {
    const chain = 'tamper';
    const dir = join(env.dataDir, 'chains', chain);
    mkdirSync(dir, { recursive: true });
    // Write a block with a deliberately wrong hash. The diagnose helper
    // should compare the stored hash to the recomputed hash and flag.
    writeFileSync(
      join(dir, '000001.json'),
      JSON.stringify({
        index: 1,
        timestamp: '2026-04-13T00:00:00.000Z',
        chain,
        data: { content: 'hello' },
        prev_hash: '',
        hash: 'WRONG_HASH',
      }),
    );
    const { diagnoseChainHashes } = await import('../../src/infra/storage/chain-adapter.js');
    const result = await diagnoseChainHashes(chain);
    expect(result.totalBlocks).toBe(1);
    expect(result.mismatches).toBeGreaterThanOrEqual(1);
  });
});

describe('audit rotate handler — wraps maybeRotateAuditLog', () => {
  let dataDir: string;
  const prevEnv = { ...process.env };

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memphis-audit-rotate-'));
    process.env.MEMPHIS_SECURITY_AUDIT_LOG_PATH = join(dataDir, 'audit.jsonl');
    process.env.MEMPHIS_SECURITY_AUDIT_ARCHIVE_DIR = join(dataDir, 'archives');
    process.env.MEMPHIS_SECURITY_AUDIT_ROTATE_BYTES = '65536';
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) delete process.env[key];
    }
    Object.assign(process.env, prevEnv);
  });

  it('returns rotated=false when log is below threshold', async () => {
    writeFileSync(process.env.MEMPHIS_SECURITY_AUDIT_LOG_PATH!, 'tiny\n');
    const { maybeRotateAuditLog } = await import('../../src/infra/logging/audit-rotation.js');
    const result = maybeRotateAuditLog();
    expect(result.rotated).toBe(false);
  });

  it('returns rotated=true with archivePath when over threshold', async () => {
    writeFileSync(process.env.MEMPHIS_SECURITY_AUDIT_LOG_PATH!, 'x'.padEnd(70_000, '.') + '\n');
    const { maybeRotateAuditLog } = await import('../../src/infra/logging/audit-rotation.js');
    const result = maybeRotateAuditLog();
    expect(result.rotated).toBe(true);
    expect(result.archivePath).toMatch(/\.jsonl\.gz$/);
  });
});

describe('rate-limit hot-swap via post-apply hook', () => {
  it('setMaxRequests changes the cap on the live limiter', () => {
    const limiter = new RateLimiter(5, 60_000);
    expect(limiter.getMaxRequests()).toBe(5);
    const result = limiter.setMaxRequests(20);
    expect(result.changed).toBe(true);
    expect(result.previous).toBe(5);
    expect(result.next).toBe(20);
    expect(limiter.getMaxRequests()).toBe(20);
  });

  it('setMaxRequests reports no-op when value matches', () => {
    const limiter = new RateLimiter(5, 60_000);
    const result = limiter.setMaxRequests(5);
    expect(result.changed).toBe(false);
  });

  it('rejects non-positive values', () => {
    const limiter = new RateLimiter(5, 60_000);
    expect(() => limiter.setMaxRequests(0)).toThrow(/positive number/);
    expect(() => limiter.setMaxRequests(-1)).toThrow(/positive number/);
  });

  it('post-apply hook for MEMPHIS_RATE_LIMIT_GLOBAL_MAX updates the global singleton', async () => {
    const before = globalLimiter.getMaxRequests();
    await runPostApplyHooks({
      changes: [
        { key: 'MEMPHIS_RATE_LIMIT_GLOBAL_MAX', oldValue: String(before), newValue: '777' },
      ],
    });
    expect(globalLimiter.getMaxRequests()).toBe(777);
    // restore for other tests
    globalLimiter.setMaxRequests(before);
  });

  it('post-apply hook for MEMPHIS_RATE_LIMIT_SENSITIVE_MAX updates sensitive + exec limiters', async () => {
    const before = sensitiveLimiter.getMaxRequests();
    await runPostApplyHooks({
      changes: [
        {
          key: 'MEMPHIS_RATE_LIMIT_SENSITIVE_MAX',
          oldValue: String(before),
          newValue: '99',
        },
      ],
    });
    expect(sensitiveLimiter.getMaxRequests()).toBe(99);
    sensitiveLimiter.setMaxRequests(before);
  });
});
