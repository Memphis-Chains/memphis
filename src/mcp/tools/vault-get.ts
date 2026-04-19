import { isSessionAuthorized } from '../../infra/auth/operator-gate.js';
import { listVaultEntryMetadata, readVaultSecretByKey } from '../../security/vault-boundary.js';

export interface VaultGetInput {
  key: string;
}

export interface VaultGetOutput {
  found: boolean;
  key: string;
  plaintext?: string;
  createdAt?: string;
  error?: string;
}

export interface VaultListOutput {
  count: number;
  keys: Array<{ key: string; createdAt: string }>;
  error?: string;
}

/**
 * Retrieve and decrypt a vault secret by key name.
 * Requires Rust bridge — returns a clear error if unavailable.
 * Requires operator authentication (session must be authorized).
 */
export function runMemphisVaultGet(input: VaultGetInput): VaultGetOutput {
  if (!isSessionAuthorized()) {
    return {
      found: false,
      key: input.key,
      error: 'Operator authentication required. Run: memphis operator login',
    };
  }
  return readVaultSecretByKey(input.key, { surface: 'mcp' });
}

/**
 * List vault entry keys (metadata only, no decryption).
 * Requires operator authentication (session must be authorized).
 */
export function runMemphisVaultList(): VaultListOutput {
  if (!isSessionAuthorized()) {
    return {
      count: 0,
      keys: [],
      error: 'Operator authentication required. Run: memphis operator login',
    };
  }
  const keys = listVaultEntryMetadata({ surface: 'mcp' }, process.env, undefined, {
    latestPerKey: true,
  }).map(({ key, createdAt }) => ({ key, createdAt }));
  return { count: keys.length, keys };
}
