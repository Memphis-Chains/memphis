import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/soul/manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/soul/manifest.js')>();
  return {
    ...actual,
    loadSoulManifest: vi.fn(() => ({
      schemaVersion: 1,
      generatedAt: '2026-04-01T00:00:00.000Z',
      identity: {
        agentName: 'Memphis',
        ownerName: 'operator',
        runtimeMode: 'local',
        createdAt: '2026-04-01T00:00:00.000Z',
      },
      capabilities: {
        tools: [],
        chains: [],
        channels: [],
        providers: [],
        rustBridge: false,
      },
      boundaries: {
        tier0: { auth: 'none', scope: 'local' },
        tier1: { auth: 'token', scope: 'local' },
        tier2: { auth: 'passphrase', scope: 'sensitive' },
      },
      evolution: {
        autoApproveReflections: false,
        requirePassphraseForTier2: true,
        snapshotBeforeEvolution: true,
      },
      mode: 'balanced',
      trustRules: [
        { tool: 'memphis_journal', autoApprove: true, addedAt: '2026-04-01T00:00:00.000Z' },
      ],
    })),
  };
});

import { createInProcessToolExecutor } from '../../src/gateway/tool-executor.js';

describe('in-process tool executor policy convergence', () => {
  it('honors explicit operator deny policies before manifest trust rules', async () => {
    const executor = createInProcessToolExecutor({
      permissionRepo: {
        get: vi.fn(() => ({ tool_name: 'memphis_journal', policy: 'deny', updated_at: 'now' })),
      } as never,
    });

    await expect(
      executor.execute({
        id: 'call-1',
        name: 'memphis_journal',
        arguments: { content: 'blocked' },
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
    });
  });
});
