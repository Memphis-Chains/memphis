/**
 * Shared onboarding utilities used by both `setup` and `onboarding-wizard`.
 * Reduces duplication between the two entry points.
 */

import { randomBytes } from 'node:crypto';

import { getRustVaultAdapterStatus } from '../../storage/rust-vault-adapter.js';

export type ConnectivityCheck = {
  ok: boolean;
  target: string;
  statusCode?: number;
  message: string;
};

export function generateVaultPepper(): string {
  return `memphis-${randomBytes(16).toString('hex')}`;
}

export function generateSecureToken(): string {
  return randomBytes(24).toString('base64url');
}

export function normalizeDataDirectory(dataDirectory: string): { directory: string; databaseUrl: string } {
  const trimmed = dataDirectory.trim() || './data';
  const cleaned = trimmed.replace(/[\\]+/g, '/').replace(/\/$/, '') || './data';

  if (cleaned.startsWith('/')) {
    return {
      directory: cleaned,
      databaseUrl: `file:${cleaned}/memphis.db`,
    };
  }

  const relative = cleaned.startsWith('./') || cleaned.startsWith('../') ? cleaned : `./${cleaned}`;
  return {
    directory: relative,
    databaseUrl: `file:${relative}/memphis.db`,
  };
}

export type SetupProviderChoice = 'ollama' | 'openai' | 'anthropic' | 'decentralized' | 'custom' | 'local';

export async function validateProviderConnectivity(
  env: Record<string, string | undefined>,
  provider: SetupProviderChoice,
): Promise<ConnectivityCheck | undefined> {
  if (provider === 'local') {
    return {
      ok: true,
      target: 'local-fallback',
      message: 'Local provider selected, no remote connectivity required.',
    };
  }

  const target =
    provider === 'ollama'
      ? `${env.OLLAMA_URL ?? 'http://127.0.0.1:11434'}/api/tags`
      : provider === 'decentralized'
        ? env.DECENTRALIZED_LLM_API_BASE
        : env.SHARED_LLM_API_BASE;

  if (!target) {
    return {
      ok: false,
      target: 'unknown',
      message: 'Provider endpoint is missing in generated configuration.',
    };
  }

  try {
    const response = await fetch(target, { method: 'GET', signal: AbortSignal.timeout(3000) });
    if (response.ok || response.status < 500) {
      return {
        ok: true,
        target,
        statusCode: response.status,
        message: `Connectivity check reachable (status ${response.status}).`,
      };
    }
    return {
      ok: false,
      target,
      statusCode: response.status,
      message: `Provider endpoint returned status ${response.status}.`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, target, message: `Connectivity check failed: ${message}` };
  }
}

export type RustBridgeStatus = {
  bridgeLoaded: boolean;
  vaultApiAvailable: boolean;
  warnings: string[];
};

export function checkRustBridgeStatus(
  env: NodeJS.ProcessEnv,
): RustBridgeStatus {
  const status = getRustVaultAdapterStatus(env);
  const warnings: string[] = [];
  if (!status.bridgeLoaded || !status.vaultApiAvailable) {
    warnings.push(
      'Rust bridge unavailable — vault and embedding features will not work until you run: npm run build:rust',
    );
  }
  return {
    bridgeLoaded: status.bridgeLoaded,
    vaultApiAvailable: status.vaultApiAvailable,
    warnings,
  };
}
