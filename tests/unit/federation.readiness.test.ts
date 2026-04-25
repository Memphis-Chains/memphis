import { describe, expect, it } from 'vitest';

import { getFederationReadinessStatus } from '../../src/federation/readiness.js';

describe('getFederationReadinessStatus', () => {
  const vaultReady = {
    bridgeLoaded: true,
    vaultApiAvailable: true,
    loadedNative: false,
    adapterVersion: undefined,
    fallbackReason: undefined,
  };

  const vaultUnavailable = {
    bridgeLoaded: false,
    vaultApiAvailable: false,
    loadedNative: false,
    adapterVersion: undefined,
    fallbackReason: 'missing bridge',
  };

  it('reports trusted pilot readiness only when matrix is configured and peer storage exists', () => {
    const status = getFederationReadinessStatus(
      {
        MEMPHIS_MATRIX_ENABLED: 'true',
        MEMPHIS_MATRIX_HOMESERVER: 'https://matrix.internal.example',
        MEMPHIS_MATRIX_ACCESS_TOKEN: 'vault-managed-token',
        MEMPHIS_MATRIX_ADMIN_USER: 'memphis_admin',
      },
      vaultReady,
      {} as never,
    );

    expect(status.federation).toBe('ready');
    expect(status.trustMode).toBe('trusted-pilot');
    expect(status.vault).toBe('available');
    expect(status.matrix.peerStorageReady).toBe(true);
    expect(status.reasons).toEqual([]);
  });

  it('returns explicit pilot blockers when configuration is incomplete', () => {
    const status = getFederationReadinessStatus(
      {
        MEMPHIS_MATRIX_ENABLED: 'true',
      },
      vaultUnavailable,
    );

    expect(status.federation).toBe('unavailable');
    expect(status.reasons).toContain('MEMPHIS_MATRIX_HOMESERVER not configured');
    expect(status.reasons).toContain('MEMPHIS_MATRIX_ACCESS_TOKEN not configured');
    expect(status.reasons).toContain('Peer storage not initialized');
    expect(status.reasons).toContain(
      'Vault bridge required for trusted Matrix pilot (MP v0 needs an unlocked vault to access the operator signing seed)',
    );
  });

  it('keeps public federation explicitly deferred', () => {
    const status = getFederationReadinessStatus(
      {
        MEMPHIS_MATRIX_ENABLED: 'true',
        MEMPHIS_MATRIX_HOMESERVER: 'https://matrix.example',
        MEMPHIS_MATRIX_ACCESS_TOKEN: 'token',
        MEMPHIS_MATRIX_TRUST_MODE: 'public',
      },
      vaultReady,
      {} as never,
    );

    expect(status.federation).toBe('unavailable');
    expect(status.trustMode).toBe('public-deferred');
    expect(status.reasons).toContain('Public Matrix federation hardening is deferred');
  });
});
