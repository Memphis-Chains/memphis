/**
 * S5-4 regression: rawEnv must thread from runMemphisSelfModify deps
 * into ensureSoulManifest + loadSoulManifest so per-request env
 * overrides (e.g. MEMPHIS_AUTONOMY_MODE=full carried in an HTTP
 * request env bag) reach the manifest read.
 *
 * Without this thread, prior code called loadSoulManifest() with no
 * arg → defaulted to process.env → daemon-time env, dropping the
 * per-request intent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { runMemphisSelfModify } from '../../src/mcp/tools/self-modify.js';

vi.mock('../../src/soul/manifest.js', () => {
  return {
    ensureSoulManifest: vi.fn(),
    loadSoulManifest: vi.fn(() => null),
  };
});

vi.mock('../../src/infra/git-utils.js', () => ({
  isGitRepo: vi.fn().mockResolvedValue(true),
}));

const manifestModule = (await import('../../src/soul/manifest.js')) as unknown as {
  ensureSoulManifest: ReturnType<typeof vi.fn>;
  loadSoulManifest: ReturnType<typeof vi.fn>;
};

const fakeDeps = {
  sessionRepo: {
    create: vi.fn().mockReturnValue({ id: 'sess-1' }),
    updateStatus: vi.fn(),
    getById: vi.fn().mockReturnValue(null),
  },
  rollback: {
    createSnapshot: vi.fn().mockResolvedValue('snap-1'),
    rollback: vi.fn(),
  },
  caseAdapter: {
    appendBlock: vi.fn(),
  },
  projectRoot: '/tmp/fake',
} as unknown as Parameters<typeof runMemphisSelfModify>[1];

afterEach(() => {
  vi.clearAllMocks();
});

describe('runMemphisSelfModify rawEnv threading (S5-4)', () => {
  it('passes deps.rawEnv to ensureSoulManifest + loadSoulManifest', async () => {
    const customEnv = {
      ...process.env,
      MEMPHIS_AUTONOMY_MODE: 'full',
      __TEST_MARKER__: 'rawenv-threaded',
    };

    await runMemphisSelfModify(
      {
        intent: 'test',
        files: ['file.ts'],
        changes: { 'file.ts': 'content' },
      },
      { ...fakeDeps, rawEnv: customEnv },
    );

    // Both calls receive the per-request env, not undefined or process.env.
    expect(manifestModule.ensureSoulManifest).toHaveBeenCalledWith(customEnv);
    expect(manifestModule.loadSoulManifest).toHaveBeenCalledWith(customEnv);
    // Verify the marker survives — proves the env isn't being filtered
    // somewhere in the call chain.
    const calls = manifestModule.loadSoulManifest.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]?.__TEST_MARKER__).toBe('rawenv-threaded');
  });

  it('falls back to undefined (loadSoulManifest default = process.env) when deps.rawEnv omitted', async () => {
    await runMemphisSelfModify(
      {
        intent: 'test',
        files: ['file.ts'],
        changes: { 'file.ts': 'content' },
      },
      fakeDeps,
    );

    // ensureSoulManifest() called with undefined → its own default kicks in.
    expect(manifestModule.ensureSoulManifest).toHaveBeenCalledWith(undefined);
    expect(manifestModule.loadSoulManifest).toHaveBeenCalledWith(undefined);
  });
});

