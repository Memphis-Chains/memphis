import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { runMemphisSelfGovernanceStatus } from '../../src/mcp/tools/self-governance-status.js';
import { runMemphisSelfModify } from '../../src/mcp/tools/self-modify.js';

afterEach(() => vi.unstubAllEnvs());

it('uses the actual empty-telemetry governance result to refuse self-modification', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'memphis-governance-integration-'));
  const other = mkdtempSync(join(tmpdir(), 'memphis-governance-other-'));
  mkdirSync(join(other, 'backups'));
  writeFileSync(join(other, 'backups', 'other-runtime.tar.gz'), 'synthetic');
  vi.stubEnv('MEMPHIS_DATA_DIR', other);
  const env = { ...process.env, HOME: dir, MEMPHIS_DATA_DIR: dir, MEMPHIS_ENV_FILE: join(dir, 'missing-env'),
    DEFAULT_PROVIDER: 'local-fallback', LOCAL_FALLBACK_ENABLED: 'true', RUST_CHAIN_ENABLED: 'false' };
  const snapshot = await runMemphisSelfGovernanceStatus(env);
  expect(snapshot.sloWindows?.['24h'].status).toBe('unavailable');
  expect(snapshot.freshness.latestBackupArchive).toBeUndefined();
  expect(snapshot.canSelfModify).toBe(false);
  const create = vi.fn();
  const result = await runMemphisSelfModify({ intent: 'synthetic', files: ['file.ts'], changes: { 'file.ts': 'synthetic' } }, {
    sessionRepo: { create }, rollback: {}, caseAdapter: {}, rawEnv: env, projectRoot: dir,
  } as unknown as Parameters<typeof runMemphisSelfModify>[1]);
  expect(result.success).toBe(false);
  expect(result.rollbackReason).toContain('Self-modification blocked');
  expect(create).not.toHaveBeenCalled();
}, 30_000);
