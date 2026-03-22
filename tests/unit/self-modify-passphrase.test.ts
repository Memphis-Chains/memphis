/**
 * Unit tests for the passphrase gate in self-modify (tier 2).
 */
import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runMemphisSelfModify } from '../../src/mcp/tools/self-modify.js';
import type { SoulManifest } from '../../src/soul/types.js';

// Mock all heavy dependencies so we only test the passphrase gate logic
vi.mock('../../src/soul/manifest.js', () => {
  let mockManifest: SoulManifest | null = null;
  return {
    ensureSoulManifest: vi.fn(() => mockManifest),
    loadSoulManifest: vi.fn(() => mockManifest),
    __setMockManifest: (m: SoulManifest | null) => {
      mockManifest = m;
    },
  };
});

vi.mock('../../src/infra/git-utils.js', () => ({
  isGitRepo: vi.fn().mockResolvedValue(true),
  getCurrentBranch: vi.fn().mockResolvedValue('main'),
  createBranch: vi.fn(),
  switchBranch: vi.fn(),
  mergeBranch: vi.fn(),
  deleteBranch: vi.fn(),
  commitAll: vi.fn().mockResolvedValue('abc123'),
}));

vi.mock('../../src/infra/test-gate.js', () => ({
  runTestGate: vi.fn().mockResolvedValue({ passed: true, steps: [] }),
}));

const manifestMock = await import('../../src/soul/manifest.js') as {
  __setMockManifest: (m: SoulManifest | null) => void;
};

function makeManifest(overrides: Partial<SoulManifest['evolution']> = {}): SoulManifest {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    identity: {
      agentName: 'test',
      ownerName: 'test',
      runtimeMode: 'test',
      createdAt: new Date().toISOString(),
    },
    capabilities: { tools: [], chains: [], channels: [], providers: [], rustBridge: false },
    boundaries: {
      tier0: { auth: 'none', scope: 'test' },
      tier1: { auth: 'none', scope: 'test' },
      tier2: { auth: 'none', scope: 'test' },
    },
    evolution: {
      autoApproveReflections: true,
      requirePassphraseForTier2: false,
      snapshotBeforeEvolution: false,
      ...overrides,
    },
    mode: 'quiet',
    trustRules: [],
  };
}

const PASSPHRASE = 'my-secret-passphrase-123';
const PASSPHRASE_HASH = createHash('sha256').update(PASSPHRASE).digest('hex');

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
    appendCaseEntry: vi.fn(),
  },
  projectRoot: '/tmp/test-project',
} as unknown as Parameters<typeof runMemphisSelfModify>[1];

const baseInput = {
  intent: 'test change',
  files: ['src/test.ts'],
  changes: { 'src/test.ts': '// updated' },
};

describe('self-modify passphrase gate', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('allows self-modify when requirePassphraseForTier2 is false', async () => {
    manifestMock.__setMockManifest(makeManifest({ requirePassphraseForTier2: false }));
    const result = await runMemphisSelfModify(baseInput, fakeDeps);
    expect(result.status).not.toBe('error');
  });

  it('rejects when passphrase required but no passphraseHash configured', async () => {
    manifestMock.__setMockManifest(
      makeManifest({ requirePassphraseForTier2: true }),
    );
    const result = await runMemphisSelfModify(baseInput, fakeDeps);
    expect(result.success).toBe(false);
    expect(result.status).toBe('error');
    expect(result.rollbackReason).toContain('no passphraseHash configured');
  });

  it('rejects when passphrase required but not provided', async () => {
    manifestMock.__setMockManifest(
      makeManifest({ requirePassphraseForTier2: true, passphraseHash: PASSPHRASE_HASH }),
    );
    const result = await runMemphisSelfModify(baseInput, fakeDeps);
    expect(result.success).toBe(false);
    expect(result.status).toBe('error');
    expect(result.rollbackReason).toContain('Passphrase required');
  });

  it('rejects when passphrase is wrong', async () => {
    manifestMock.__setMockManifest(
      makeManifest({ requirePassphraseForTier2: true, passphraseHash: PASSPHRASE_HASH }),
    );
    const result = await runMemphisSelfModify(
      { ...baseInput, passphrase: 'wrong-passphrase' },
      fakeDeps,
    );
    expect(result.success).toBe(false);
    expect(result.status).toBe('error');
    expect(result.rollbackReason).toContain('hash mismatch');
  });

  it('allows when correct passphrase is provided', async () => {
    manifestMock.__setMockManifest(
      makeManifest({ requirePassphraseForTier2: true, passphraseHash: PASSPHRASE_HASH }),
    );
    const result = await runMemphisSelfModify(
      { ...baseInput, passphrase: PASSPHRASE },
      fakeDeps,
    );
    // Should pass the gate (may fail later due to mocked git, but shouldn't be 'error' from passphrase)
    expect(result.rollbackReason ?? '').not.toContain('Passphrase');
    expect(result.rollbackReason ?? '').not.toContain('hash mismatch');
  });
});
