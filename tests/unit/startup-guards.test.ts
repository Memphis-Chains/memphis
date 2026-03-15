import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  evaluateRevocationCacheStartup,
  evaluateTrustRootStartup,
} from '../../src/infra/runtime/startup-guards.js';

describe('startup guards', () => {
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
});
