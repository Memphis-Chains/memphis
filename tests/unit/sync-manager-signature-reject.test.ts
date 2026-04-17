import { describe, expect, it } from 'vitest';

import { SyncManager } from '../../src/sync/sync-manager.ts';

/**
 * Regression net for #142. SyncManager.writeChain used to forward peer
 * blocks into the chain via appendPrecomputedBlock with no signature
 * check. Now unsigned remote blocks are rejected unless
 * MEMPHIS_SYNC_ACCEPT_UNSIGNED=true. Blocks with signer+signature go
 * through the Rust chain_validate bridge.
 *
 * These tests exercise only the sync-side policy — the Rust bridge
 * path is covered by tests/integration/signed-block-gate.test.ts.
 */

describe('SyncManager — unsigned peer block rejection (#142)', () => {
  it('rejects an unsigned peer block when MEMPHIS_SYNC_ACCEPT_UNSIGNED is NOT set', async () => {
    const prior = process.env.MEMPHIS_SYNC_ACCEPT_UNSIGNED;
    delete process.env.MEMPHIS_SYNC_ACCEPT_UNSIGNED;
    try {
      const manager = new SyncManager('did:memphis:self');
      const unsigned = [
        {
          index: 0,
          timestamp: '2026-04-17T00:00:00Z',
          hash: 'a'.repeat(64),
          chain: 'journal',
          data: { content: 'hostile-unsigned', tags: [] },
        },
      ];
      // writeChain is private; we reach it through the internal test
      // seam. The test passes iff the promise rejects with the
      // "refusing to accept unsigned" message.
      await expect(
        (
          manager as unknown as {
            writeChain: (c: string, b: unknown[]) => Promise<void>;
          }
        ).writeChain('journal', unsigned),
      ).rejects.toThrow(/unsigned/i);
    } finally {
      if (prior === undefined) delete process.env.MEMPHIS_SYNC_ACCEPT_UNSIGNED;
      else process.env.MEMPHIS_SYNC_ACCEPT_UNSIGNED = prior;
    }
  });

  it('does NOT reject unsigned blocks when MEMPHIS_SYNC_ACCEPT_UNSIGNED=true (escape hatch)', async () => {
    const prior = process.env.MEMPHIS_SYNC_ACCEPT_UNSIGNED;
    const priorDataDir = process.env.MEMPHIS_DATA_DIR;
    process.env.MEMPHIS_SYNC_ACCEPT_UNSIGNED = 'true';
    // Isolate the actual append side-effect — point at a tmpdir.
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    process.env.MEMPHIS_DATA_DIR = mkdtempSync(join(tmpdir(), 'memphis-sync-accept-unsigned-'));
    try {
      const manager = new SyncManager('did:memphis:self');
      const unsigned = [
        {
          index: 0,
          timestamp: '2026-04-17T00:00:00Z',
          hash: 'b'.repeat(64),
          chain: 'journal',
          data: { content: 'legacy-unsigned', tags: [] },
        },
      ];
      // With the escape hatch set, the signature check must pass. The
      // actual append may still fail because the test doesn't stand up
      // a full chain dir — that's fine, we just need to prove the
      // signature policy didn't reject.
      let signatureRejected = false;
      try {
        await (
          manager as unknown as {
            writeChain: (c: string, b: unknown[]) => Promise<void>;
          }
        ).writeChain('journal', unsigned);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Match the specific sync-policy rejection phrasing. The tmp
        // path itself contains "unsigned" so a looser regex false-
        // positives on unrelated ENOENT errors.
        if (/refusing to accept unsigned|refusing peer block with invalid/i.test(msg)) {
          signatureRejected = true;
        }
      }
      expect(signatureRejected).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.MEMPHIS_SYNC_ACCEPT_UNSIGNED;
      else process.env.MEMPHIS_SYNC_ACCEPT_UNSIGNED = prior;
      if (priorDataDir === undefined) delete process.env.MEMPHIS_DATA_DIR;
      else process.env.MEMPHIS_DATA_DIR = priorDataDir;
    }
  });

  it('rejects a block with signer+signature that fails verification', async () => {
    const prior = process.env.MEMPHIS_SYNC_ACCEPT_UNSIGNED;
    delete process.env.MEMPHIS_SYNC_ACCEPT_UNSIGNED;
    try {
      const manager = new SyncManager('did:memphis:self');
      // 32-byte hex signer + 64-byte hex signature — well-formed,
      // cryptographically invalid for the content.
      const bogus = [
        {
          index: 0,
          timestamp: '2026-04-17T00:00:00Z',
          hash: 'c'.repeat(64),
          chain: 'journal',
          data: { content: 'bogus-signed', tags: [] },
          signer: 'a'.repeat(64),
          signature: 'f'.repeat(128),
        },
      ];
      await expect(
        (
          manager as unknown as {
            writeChain: (c: string, b: unknown[]) => Promise<void>;
          }
        ).writeChain('journal', bogus),
      ).rejects.toThrow(/invalid signature|unsigned|rust chain bridge unavailable/i);
      // The rust-bridge-unavailable fallback is allowed because on CI
      // without the Rust binary verifyChainBlockSignature returns false
      // via the catch branch, which still fails the signature check
      // and surfaces as "invalid signature".
    } finally {
      if (prior === undefined) delete process.env.MEMPHIS_SYNC_ACCEPT_UNSIGNED;
      else process.env.MEMPHIS_SYNC_ACCEPT_UNSIGNED = prior;
    }
  });
});
