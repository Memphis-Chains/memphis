import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  buildSoulBootPrompt,
  buildSoulManifestFragment,
  buildSoulMemoryFragment,
  isSoulBootNeeded,
} from '../../src/soul/boot.js';

vi.mock('../../src/soul/memory.js', () => ({
  loadSoulMemory: vi.fn(),
  isSoulMemoryEmpty: vi.fn(),
}));

describe('soul boot', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('boot needed when memory is null', async () => {
    const { loadSoulMemory, isSoulMemoryEmpty } = await import('../../src/soul/memory.js');
    vi.mocked(loadSoulMemory).mockReturnValue(null);
    vi.mocked(isSoulMemoryEmpty).mockReturnValue(true);

    expect(isSoulBootNeeded()).toBe(true);
  });

  it('boot needed when memory is empty', async () => {
    const { loadSoulMemory, isSoulMemoryEmpty } = await import('../../src/soul/memory.js');
    vi.mocked(loadSoulMemory).mockReturnValue({
      schemaVersion: 1,
      lastUpdated: new Date().toISOString(),
    } as never);
    vi.mocked(isSoulMemoryEmpty).mockReturnValue(true);

    expect(isSoulBootNeeded()).toBe(true);
  });

  it('boot not needed when memory has data', async () => {
    const { loadSoulMemory, isSoulMemoryEmpty } = await import('../../src/soul/memory.js');
    vi.mocked(loadSoulMemory).mockReturnValue({
      schemaVersion: 1,
      lastUpdated: new Date().toISOString(),
      user: { name: 'Test' },
    } as never);
    vi.mocked(isSoulMemoryEmpty).mockReturnValue(false);

    expect(isSoulBootNeeded()).toBe(false);
  });

  it('manifest fragment includes agent name and mode', () => {
    const manifest = {
      identity: {
        agentName: 'Memphis',
        ownerName: 'user',
        runtimeMode: 'balanced',
        createdAt: '2026-01-01T00:00:00Z',
      },
      capabilities: { tools: [], chains: [], channels: [], rustBridge: false },
      boundaries: {},
    } as never;
    const fragment = buildSoulManifestFragment(manifest);
    expect(fragment).toContain('Memphis');
    expect(fragment).toContain('balanced');
  });

  it('memory fragment includes user and self sections', () => {
    const memory = {
      schemaVersion: 1,
      lastUpdated: '2026-01-01T00:00:00Z',
      user: { name: 'Alice', preferences: ['dark mode'] },
      self: { personality: 'helpful' },
    } as never;
    const fragment = buildSoulMemoryFragment(memory);
    expect(fragment).toContain('Alice');
    expect(fragment).toContain('helpful');
  });

  it('boot prompt personalizes with agent name', () => {
    const manifest = {
      identity: { agentName: 'Memphis', did: 'did:memphis:z123' },
    } as never;
    const prompt = buildSoulBootPrompt(manifest);
    expect(prompt).toContain('Memphis');
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });
});
