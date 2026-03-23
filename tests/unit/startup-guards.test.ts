import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  evaluateRevocationCacheStartup,
  evaluateTrustRootDowngrade,
  evaluateTrustRootStartup,
} from '../../src/infra/runtime/startup-guards.js';

describe('startup guards — trust root', () => {
  it('disabled by default', () => {
    const out = evaluateTrustRootStartup({} as NodeJS.ProcessEnv);
    expect(out.enabled).toBe(false);
    expect(out.valid).toBe(true);
  });

  it('rejects invalid trust root manifest when required', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-trust-root-'));
    const path = join(dir, 'trust_root.json');
    writeFileSync(path, JSON.stringify({ version: 1, rootIds: [] }), 'utf8');

    const out = evaluateTrustRootStartup({
      MEMPHIS_TRUST_ROOT_REQUIRED: 'true',
      MEMPHIS_TRUST_ROOT_PATH: path,
    } as NodeJS.ProcessEnv);

    expect(out.enabled).toBe(true);
    expect(out.valid).toBe(false);
    expect(out.reason).toContain('schema invalid');
  });

  it('accepts valid trust root with non-empty rootIds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-trust-root-'));
    const path = join(dir, 'trust_root.json');
    writeFileSync(path, JSON.stringify({ version: 1, rootIds: ['root-1', 'root-2'] }), 'utf8');

    const out = evaluateTrustRootStartup({
      MEMPHIS_TRUST_ROOT_REQUIRED: 'true',
      MEMPHIS_TRUST_ROOT_PATH: path,
    } as NodeJS.ProcessEnv);

    expect(out.enabled).toBe(true);
    expect(out.valid).toBe(true);
  });

  it('invalid when trust root file is missing', () => {
    const out = evaluateTrustRootStartup({
      MEMPHIS_TRUST_ROOT_REQUIRED: 'true',
      MEMPHIS_TRUST_ROOT_PATH: '/nonexistent/trust_root.json',
    } as NodeJS.ProcessEnv);

    expect(out.enabled).toBe(true);
    expect(out.valid).toBe(false);
  });

  it('invalid when trust root file has bad JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-trust-root-'));
    const path = join(dir, 'trust_root.json');
    writeFileSync(path, '{not valid json', 'utf8');

    const out = evaluateTrustRootStartup({
      MEMPHIS_TRUST_ROOT_REQUIRED: 'true',
      MEMPHIS_TRUST_ROOT_PATH: path,
    } as NodeJS.ProcessEnv);

    expect(out.enabled).toBe(true);
    expect(out.valid).toBe(false);
  });

  it('rejects duplicate rootIds', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-trust-root-'));
    const path = join(dir, 'trust_root.json');
    writeFileSync(path, JSON.stringify({ version: 1, rootIds: ['id1', 'id1'] }), 'utf8');

    const out = evaluateTrustRootStartup({
      MEMPHIS_TRUST_ROOT_REQUIRED: 'true',
      MEMPHIS_TRUST_ROOT_PATH: path,
    } as NodeJS.ProcessEnv);

    expect(out.enabled).toBe(true);
    expect(out.valid).toBe(false);
  });
});

describe('startup guards — trust root downgrade', () => {
  it('allows when no current trust root path', () => {
    const out = evaluateTrustRootDowngrade(null, { version: 2 });
    expect(out.allowed).toBe(true);
  });

  it('allows when current path does not exist', () => {
    const out = evaluateTrustRootDowngrade('/nonexistent/path.json', { version: 1 });
    expect(out.allowed).toBe(true);
  });

  it('rejects version downgrade', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-trust-root-'));
    const path = join(dir, 'trust_root.json');
    writeFileSync(path, JSON.stringify({ version: 5, rootIds: ['r1'] }), 'utf8');

    const out = evaluateTrustRootDowngrade(path, { version: 3 });
    expect(out.allowed).toBe(false);
    expect(out.reason).toContain('downgrade');
  });

  it('allows same version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-trust-root-'));
    const path = join(dir, 'trust_root.json');
    writeFileSync(path, JSON.stringify({ version: 2, rootIds: ['r1'] }), 'utf8');

    const out = evaluateTrustRootDowngrade(path, { version: 2 });
    expect(out.allowed).toBe(true);
  });

  it('allows upgrade', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-trust-root-'));
    const path = join(dir, 'trust_root.json');
    writeFileSync(path, JSON.stringify({ version: 1, rootIds: ['r1'] }), 'utf8');

    const out = evaluateTrustRootDowngrade(path, { version: 3 });
    expect(out.allowed).toBe(true);
  });

  it('rejects when incoming manifest has no version', () => {
    const out = evaluateTrustRootDowngrade(null, {});
    expect(out.allowed).toBe(false);
    expect(out.reason).toContain('no valid integer version');
  });
});

describe('startup guards — revocation cache', () => {
  it('disabled by default', () => {
    const out = evaluateRevocationCacheStartup({} as NodeJS.ProcessEnv);
    expect(out.enabled).toBe(false);
    expect(out.stale).toBe(false);
  });

  it('marks revocation cache stale when sync timestamp is missing', () => {
    const out = evaluateRevocationCacheStartup(
      {
        MEMPHIS_REVOCATION_CACHE_REQUIRED: 'true',
        MEMPHIS_REVOCATION_CACHE_MAX_STALE_MS: '30000',
      } as NodeJS.ProcessEnv,
      1_000_000,
    );

    expect(out.enabled).toBe(true);
    expect(out.stale).toBe(true);
    expect(out.reason).toContain('missing MEMPHIS_REVOCATION_CACHE_LAST_SYNC_MS');
  });

  it('fresh when last sync is recent', () => {
    const now = 1_000_000;
    const out = evaluateRevocationCacheStartup(
      {
        MEMPHIS_REVOCATION_CACHE_REQUIRED: 'true',
        MEMPHIS_REVOCATION_CACHE_MAX_STALE_MS: '30000',
        MEMPHIS_REVOCATION_CACHE_LAST_SYNC_MS: String(now - 5000),
      } as NodeJS.ProcessEnv,
      now,
    );

    expect(out.enabled).toBe(true);
    expect(out.stale).toBe(false);
  });

  it('stale when last sync exceeds max stale age', () => {
    const now = 1_000_000;
    const out = evaluateRevocationCacheStartup(
      {
        MEMPHIS_REVOCATION_CACHE_REQUIRED: 'true',
        MEMPHIS_REVOCATION_CACHE_MAX_STALE_MS: '10000',
        MEMPHIS_REVOCATION_CACHE_LAST_SYNC_MS: String(now - 50000),
      } as NodeJS.ProcessEnv,
      now,
    );

    expect(out.enabled).toBe(true);
    expect(out.stale).toBe(true);
  });
});
