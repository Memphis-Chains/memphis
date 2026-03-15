import { describe, expect, it } from 'vitest';

import { validateTrustRootTransition } from '../../src/infra/runtime/trust-root.js';

describe('trust root transition validation', () => {
  it('accepts forward-only version transition with signed metadata', () => {
    const result = validateTrustRootTransition(
      { version: 1, rootIds: ['root-v1'] },
      { version: 2, rootIds: ['root-v1', 'root-v2'], revokedKeys: ['root-old'] },
      {
        oldRootId: 'root-v1',
        newRootId: 'root-v2',
        reason: 'annual rotation',
        timestamp: '2026-03-12T10:00:00.000Z',
        signature: 'ed25519:abcdef',
      },
    );
    expect(result.ok).toBe(true);
  });

  it('rejects downgrade or same-version manifest', () => {
    const result = validateTrustRootTransition(
      { version: 7, rootIds: ['root-v7'] },
      { version: 7, rootIds: ['root-v7', 'root-v8'] },
      {
        oldRootId: 'root-v7',
        newRootId: 'root-v8',
        reason: 'rotation',
        timestamp: '2026-03-12T10:00:00.000Z',
        signature: 'ed25519:sig',
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('downgrade rejected');
  });

  it('rejects missing signature and invalid root references', () => {
    const result = validateTrustRootTransition(
      { version: 1, rootIds: ['root-v1'] },
      { version: 2, rootIds: ['root-v2'] },
      {
        oldRootId: 'root-v0',
        newRootId: 'root-v2',
        reason: 'rotation',
        timestamp: '2026-03-12T10:00:00.000Z',
        signature: '',
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('oldRootId');
  });
});
