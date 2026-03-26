import type { RustVaultAdapterStatus } from '../infra/storage/rust-vault-adapter.js';
import type { SqliteAgentPeerRepository } from '../infra/storage/sqlite/repositories/agent-peer-repository.js';

export type FederationTrustMode = 'trusted-pilot' | 'public-deferred';
export type FederationState = 'ready' | 'unavailable';

export type FederationReadinessStatus = {
  federation: FederationState;
  trustMode: FederationTrustMode;
  vault: 'available' | 'unavailable';
  reasons: string[];
  matrix: {
    enabled: boolean;
    homeserverConfigured: boolean;
    accessTokenConfigured: boolean;
    adminUserConfigured: boolean;
    peerStorageReady: boolean;
    homeserver?: string;
  };
};

function envEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function envTrustMode(rawEnv: NodeJS.ProcessEnv): FederationTrustMode {
  const value = rawEnv.MEMPHIS_MATRIX_TRUST_MODE?.trim().toLowerCase();
  if (value === 'public' || value === 'public-deferred' || value === 'untrusted') {
    return 'public-deferred';
  }
  return 'trusted-pilot';
}

function isConfiguredUrl(value: string | undefined): value is string {
  if (!value?.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function getFederationReadinessStatus(
  rawEnv: NodeJS.ProcessEnv,
  vaultStatus: RustVaultAdapterStatus,
  peerRepo?: SqliteAgentPeerRepository,
): FederationReadinessStatus {
  const trustMode = envTrustMode(rawEnv);
  const matrixEnabled = envEnabled(rawEnv.MEMPHIS_MATRIX_ENABLED);
  const homeserver = rawEnv.MEMPHIS_MATRIX_HOMESERVER?.trim();
  const homeserverConfigured = isConfiguredUrl(homeserver);
  const accessTokenConfigured = Boolean(rawEnv.MEMPHIS_MATRIX_ACCESS_TOKEN?.trim());
  const adminUserConfigured = Boolean(rawEnv.MEMPHIS_MATRIX_ADMIN_USER?.trim());
  const peerStorageReady = Boolean(peerRepo);
  const vaultReady = vaultStatus.bridgeLoaded && vaultStatus.vaultApiAvailable;

  const reasons: string[] = [];
  if (!matrixEnabled) reasons.push('Matrix federation disabled');
  if (!homeserverConfigured) reasons.push('MEMPHIS_MATRIX_HOMESERVER not configured');
  if (!accessTokenConfigured) reasons.push('MEMPHIS_MATRIX_ACCESS_TOKEN not configured');
  if (!peerStorageReady) reasons.push('Peer storage not initialized');
  if (!vaultReady) reasons.push('Vault bridge required for trusted Matrix pilot');
  if (trustMode === 'public-deferred') {
    reasons.push('Public Matrix federation hardening is deferred');
  }

  return {
    federation:
      matrixEnabled &&
      homeserverConfigured &&
      accessTokenConfigured &&
      peerStorageReady &&
      vaultReady &&
      trustMode === 'trusted-pilot'
        ? 'ready'
        : 'unavailable',
    trustMode,
    vault: vaultReady ? 'available' : 'unavailable',
    reasons,
    matrix: {
      enabled: matrixEnabled,
      homeserverConfigured,
      accessTokenConfigured,
      adminUserConfigured,
      peerStorageReady,
      homeserver: homeserverConfigured ? homeserver : undefined,
    },
  };
}
