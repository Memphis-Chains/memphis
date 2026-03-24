import { describe, expect, it } from 'vitest';

import type { Block } from '../../src/memory/chain.js';
import { detectChainDiff } from '../../src/sync/chain-diff.js';
import { resolveChainConflicts } from '../../src/sync/conflict-resolver.js';
import { SyncManager } from '../../src/sync/sync-manager.js';

describe('unit: sync', () => {
  describe('SyncManager initialization', () => {
    it('creates a SyncManager with a DID', () => {
      const manager = new SyncManager('did:memphis:test');
      expect(manager).toBeDefined();
    });

    it('listAgents returns empty initially', () => {
      const manager = new SyncManager('did:memphis:test');
      const agents = manager.listAgents();
      expect(agents).toEqual([]);
    });

    it('status returns zero counts for unknown chain', async () => {
      const manager = new SyncManager('did:memphis:test');
      const status = await manager.status('nonexistent-chain');
      expect(status.chain).toBe('nonexistent-chain');
      expect(status.localBlocks).toBe(0);
      expect(status.agentsKnown).toBe(0);
      expect(status.agentsOnline).toBe(0);
    });
  });

  describe('conflict resolution', () => {
    const makeBlock = (index: number, timestamp = new Date().toISOString()): Block => ({
      index,
      timestamp,
      chain: 'journal',
      data: { content: `block ${index}` },
      hash: `hash-${index}`,
      prev_hash: index === 0 ? '' : `hash-${index - 1}`,
    });

    it('detectChainDiff: identifies local-only and remote-only blocks', () => {
      const local: Block[] = [
        makeBlock(0),
        makeBlock(1),
        makeBlock(2),
      ];
      const remote: Block[] = [
        makeBlock(1),
        makeBlock(2),
        makeBlock(3),
      ];

      const diff = detectChainDiff(local, remote);

      expect(diff.localOnly).toHaveLength(1); // block 0
      expect(diff.remoteOnly).toHaveLength(1); // block 3
      expect(diff.conflicts).toHaveLength(0);
    });

    it('detectChainDiff: empty arrays returns empty diff', () => {
      const diff = detectChainDiff([], []);
      expect(diff.localOnly).toHaveLength(0);
      expect(diff.remoteOnly).toHaveLength(0);
      expect(diff.conflicts).toHaveLength(0);
    });

    it('detectChainDiff: fully diverged chains', () => {
      const local: Block[] = [makeBlock(0), makeBlock(1)];
      const remote: Block[] = [makeBlock(2), makeBlock(3)];

      const diff = detectChainDiff(local, remote);

      expect(diff.localOnly).toHaveLength(2);
      expect(diff.remoteOnly).toHaveLength(2);
      expect(diff.conflicts).toHaveLength(0);
    });

    it('detectChainDiff: detects content conflicts', () => {
      const local: Block[] = [
        { index: 0, hash: 'hash-0', chain: 'journal', data: { content: 'same' }, timestamp: '2026-01-01T00:00:00.000Z', prev_hash: '' },
        { index: 1, hash: 'conflict-hash', chain: 'journal', data: { content: 'local' }, timestamp: '2026-01-02T00:00:00.000Z', prev_hash: 'hash-0' },
      ];
      const remote: Block[] = [
        { index: 0, hash: 'hash-0', chain: 'journal', data: { content: 'same' }, timestamp: '2026-01-01T00:00:00.000Z', prev_hash: '' },
        { index: 1, hash: 'conflict-hash', chain: 'journal', data: { content: 'remote' }, timestamp: '2026-01-02T00:00:00.000Z', prev_hash: 'hash-0' },
      ];

      const diff = detectChainDiff(local, remote);

      expect(diff.conflicts).toHaveLength(1);
      expect(diff.conflicts[0].local.data).toEqual({ content: 'local' });
      expect(diff.conflicts[0].remote.data).toEqual({ content: 'remote' });
    });

    it('resolveChainConflicts: last-write-wins prefers newer block', () => {
      const local: Block[] = [
        { index: 0, hash: 'hash-0', chain: 'journal', data: { content: 'old' }, timestamp: '2026-01-01T00:00:00.000Z', prev_hash: '' },
        { index: 1, hash: 'hash-1', chain: 'journal', data: { content: 'local-1' }, timestamp: '2026-01-02T00:00:00.000Z', prev_hash: 'hash-0' },
      ];
      const remote: Block[] = [
        { index: 0, hash: 'hash-0', chain: 'journal', data: { content: 'old' }, timestamp: '2026-01-01T00:00:00.000Z', prev_hash: '' },
        { index: 1, hash: 'hash-1', chain: 'journal', data: { content: 'remote-1' }, timestamp: '2026-01-03T00:00:00.000Z', prev_hash: 'hash-0' },
      ];

      const resolved = resolveChainConflicts({ local, remote, strategy: 'last-write-wins' });

      // last-write-wins should pick the newer block
      const block1 = resolved.find((b) => b.index === 1);
      expect(block1?.data).toEqual({ content: 'remote-1' });
    });

    it('resolveChainConflicts: merges local-only blocks correctly', () => {
      const local: Block[] = [
        { index: 0, hash: 'hash-0', chain: 'journal', data: { content: 'same' }, timestamp: '2026-01-01T00:00:00.000Z', prev_hash: '' },
        { index: 1, hash: 'hash-1', chain: 'journal', data: { content: 'local-only' }, timestamp: '2026-01-02T00:00:00.000Z', prev_hash: 'hash-0' },
      ];
      const remote: Block[] = [
        { index: 0, hash: 'hash-0', chain: 'journal', data: { content: 'same' }, timestamp: '2026-01-01T00:00:00.000Z', prev_hash: '' },
      ];

      const resolved = resolveChainConflicts({ local, remote, strategy: 'last-write-wins' });

      // Should contain both remote block 0 and local-only block 1
      expect(resolved).toHaveLength(2);
      expect(resolved[1].data).toEqual({ content: 'local-only' });
    });

    it('resolveChainConflicts: prefer-local strategy', () => {
      const local: Block[] = [
        { index: 0, hash: 'hash-0', chain: 'journal', data: { content: 'same' }, timestamp: '2026-01-01T00:00:00.000Z', prev_hash: '' },
        { index: 1, hash: 'hash-1', chain: 'journal', data: { content: 'local-1' }, timestamp: '2026-01-02T00:00:00.000Z', prev_hash: 'hash-0' },
      ];
      const remote: Block[] = [
        { index: 0, hash: 'hash-0', chain: 'journal', data: { content: 'same' }, timestamp: '2026-01-01T00:00:00.000Z', prev_hash: '' },
        { index: 1, hash: 'hash-1', chain: 'journal', data: { content: 'remote-1' }, timestamp: '2026-01-03T00:00:00.000Z', prev_hash: 'hash-0' },
      ];

      const resolved = resolveChainConflicts({ local, remote, strategy: 'prefer-local' });

      // prefer-local should keep the local block
      const block1 = resolved.find((b) => b.index === 1);
      expect(block1?.data).toEqual({ content: 'local-1' });
    });
  });
});
