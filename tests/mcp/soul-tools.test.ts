/**
 * Unit tests for soul MCP tool handlers: runMemphisSoulRead and runMemphisSoulWrite.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  runMemphisSoulRead,
  runMemphisSoulWrite,
  type SoulReadDeps,
  type SoulWriteDeps,
} from '../../src/mcp/tools/soul.js';
import { emptySoulMemory } from '../../src/soul/memory.js';
import type { SoulManifest, SoulMemory } from '../../src/soul/types.js';

function fakeManifest(): SoulManifest {
  return {
    schemaVersion: 1,
    generatedAt: '2026-03-22T00:00:00.000Z',
    identity: {
      agentName: 'Memphis',
      ownerName: 'TestOwner',
      runtimeMode: 'dev-local',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    capabilities: {
      tools: ['memphis_journal'],
      chains: ['journal'],
      channels: ['cli'],
      providers: [],
      rustBridge: false,
    },
    boundaries: {
      tier0: { auth: 'none', scope: 'test' },
      tier1: { auth: 'api_token', scope: 'test' },
      tier2: { auth: 'vault_passphrase', scope: 'test' },
    },
    evolution: {
      autoApproveReflections: true,
      requirePassphraseForTier2: true,
      snapshotBeforeEvolution: true,
    },
  };
}

function populatedMemory(): SoulMemory {
  const memory = emptySoulMemory();
  memory.user.name = 'Alice';
  memory.user.languages = ['en', 'pl'];
  memory.user.preferences = ['concise'];
  memory.self.personality = 'curious';
  memory.self.learnings = ['user prefers TypeScript'];
  memory.context.activeWork = 'Phase A';
  return memory;
}

function makeReadDeps(memory: SoulMemory | null = populatedMemory()): SoulReadDeps {
  return {
    loadMemory: vi.fn().mockReturnValue(memory),
    loadManifest: vi.fn().mockReturnValue(fakeManifest()),
    ensureManifest: vi.fn().mockReturnValue(fakeManifest()),
  };
}

describe('runMemphisSoulRead', () => {
  it('returns manifest summary and all memory by default', async () => {
    const deps = makeReadDeps();
    const result = await runMemphisSoulRead({}, deps);

    expect(result.manifest.agent).toBe('Memphis');
    expect(result.manifest.owner).toBe('TestOwner');
    expect(result.memory).not.toBeNull();
    expect(result.memory!.user).toBeDefined();
    expect(result.memory!.self).toBeDefined();
    expect(result.memory!.context).toBeDefined();
  });

  it('returns only requested section when section is specified', async () => {
    const deps = makeReadDeps();
    const result = await runMemphisSoulRead({ section: 'user' }, deps);

    expect(result.memory!.user).toBeDefined();
    expect(result.memory!.self).toBeUndefined();
    expect(result.memory!.context).toBeUndefined();
  });

  it('returns null memory when no memory file exists', async () => {
    const deps = makeReadDeps(null);
    const result = await runMemphisSoulRead({}, deps);

    expect(result.manifest.agent).toBe('Memphis');
    expect(result.memory).toBeNull();
  });

  it('falls back to ensureManifest when loadManifest returns null', async () => {
    const deps: SoulReadDeps = {
      loadMemory: vi.fn().mockReturnValue(null),
      loadManifest: vi.fn().mockReturnValue(null),
      ensureManifest: vi.fn().mockReturnValue(fakeManifest()),
    };
    const result = await runMemphisSoulRead({}, deps);
    expect(deps.ensureManifest).toHaveBeenCalled();
    expect(result.manifest.agent).toBe('Memphis');
  });
});

describe('runMemphisSoulWrite', () => {
  function makeWriteDeps(): SoulWriteDeps {
    const memory = populatedMemory();
    return {
      update: vi.fn().mockReturnValue(memory),
      caseAdapter: {
        appendCaseEntry: vi.fn().mockResolvedValue({ ok: true }),
        queryCases: vi.fn().mockResolvedValue({ ok: true, entries: [] }),
        rebuildIndex: vi.fn().mockResolvedValue({ ok: true }),
      } as unknown as SoulWriteDeps['caseAdapter'],
      appendSoulAudit: vi.fn().mockResolvedValue({
        index: 12,
        hash: 'soul-hash',
        chain: 'soul',
        timestamp: '2026-06-16T00:00:00.000Z',
      }),
    };
  }

  it('returns success with updated sections', async () => {
    const deps = makeWriteDeps();
    const result = await runMemphisSoulWrite({ updates: { user: { name: 'Bob' } } }, deps);

    expect(result.success).toBe(true);
    expect(result.updated).toEqual(['user']);
    expect(result.timestamp).toBeTruthy();
    expect(result.soulChain).toEqual({ index: 12, hash: 'soul-hash', chain: 'soul' });
    expect(deps.appendSoulAudit).toHaveBeenCalledWith(
      'soul',
      expect.objectContaining({
        type: 'system_event',
        kind: 'soul.memory_update',
        source: 'memphis_soul_write',
        updatedSections: ['user'],
        changedKeys: ['user.name'],
      }),
    );
  });

  it('reports multiple sections when multiple are updated', async () => {
    const deps = makeWriteDeps();
    const result = await runMemphisSoulWrite(
      {
        updates: {
          user: { name: 'Bob' },
          self: { personality: 'thoughtful' },
          context: { activeWork: 'Phase B' },
        },
      },
      deps,
    );

    expect(result.updated).toEqual(['user', 'self', 'context']);
  });

  it('returns empty updated array for no-op update', async () => {
    const deps = makeWriteDeps();
    const result = await runMemphisSoulWrite({ updates: {} }, deps);

    expect(result.success).toBe(true);
    expect(result.updated).toEqual([]);
    // Should not call update at all
    expect(deps.update).not.toHaveBeenCalled();
    expect(deps.appendSoulAudit).not.toHaveBeenCalled();
  });

  it('records genitive and accusative case entries for each section', async () => {
    const deps = makeWriteDeps();
    await runMemphisSoulWrite({ updates: { user: { preferences: ['detailed'] } } }, deps);

    const appendCalls = (deps.caseAdapter.appendCaseEntry as ReturnType<typeof vi.fn>).mock.calls;
    expect(appendCalls.length).toBe(2);

    // First call: genitive (ownership)
    expect(appendCalls[0][0].case_type).toBe('genitive');
    expect(appendCalls[0][0].owner).toBe('soul');
    expect(appendCalls[0][0].possessed).toContain('user.preferences');

    // Second call: accusative (action)
    expect(appendCalls[1][0].case_type).toBe('accusative');
    expect(appendCalls[1][0].subject).toBe('agent');
    expect(appendCalls[1][0].verb).toBe('learned');
  });

  it('does not fail if case chain recording throws', async () => {
    const deps = makeWriteDeps();
    (deps.caseAdapter.appendCaseEntry as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('chain error'),
    );

    const result = await runMemphisSoulWrite({ updates: { user: { name: 'Bob' } } }, deps);

    expect(result.success).toBe(true);
    expect(result.updated).toEqual(['user']);
  });

  it('surfaces soul chain audit failure without hiding the memory update', async () => {
    const deps = makeWriteDeps();
    (deps.appendSoulAudit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('hash mismatch'));

    const result = await runMemphisSoulWrite({ updates: { user: { name: 'Bob' } } }, deps);

    expect(result.success).toBe(true);
    expect(result.updated).toEqual(['user']);
    expect(result.auditWarning).toMatch(/soul chain audit write failed: hash mismatch/);
  });
});
