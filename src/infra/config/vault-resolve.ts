import { vaultDecrypt } from '../storage/rust-vault-adapter.js';
import { getLatestVaultEntry } from '../storage/vault-entry-store.js';

const VAULT_PREFIX = 'VAULT:';

/**
 * Resolve a config value that may reference a vault secret.
 *
 * If the value starts with "VAULT:<key_name>", the latest vault entry
 * for that key is decrypted and returned. Otherwise the value is
 * returned as-is.
 *
 * Returns undefined when the vault entry does not exist or decryption
 * fails (caller decides whether that is fatal).
 */
export function resolveVaultSecret(
  value: string | undefined,
  rawEnv: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!value || !value.startsWith(VAULT_PREFIX)) return value;

  const keyName = value.slice(VAULT_PREFIX.length).trim();
  if (keyName.length === 0) return undefined;

  const entry = getLatestVaultEntry(keyName, rawEnv);
  if (!entry) {
    console.warn(
      `[memphis-config] VAULT:${keyName} referenced but no vault entry found for key "${keyName}"`,
    );
    return undefined;
  }

  try {
    return vaultDecrypt(entry, rawEnv);
  } catch (error) {
    console.warn(
      `[memphis-config] VAULT:${keyName} decryption failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/**
 * List of env keys that support VAULT: prefix resolution.
 */
const VAULT_RESOLVABLE_KEYS = [
  'SHARED_LLM_API_KEY',
  'DECENTRALIZED_LLM_API_KEY',
  'RUST_EMBED_PROVIDER_API_KEY',
  'MEMPHIS_TELEGRAM_BOT_TOKEN',
  'MEMPHIS_API_TOKEN',
] as const;

/**
 * Resolve all VAULT: prefixed values in the raw env before config
 * parsing. Mutates the provided env object so that Zod schema
 * validation sees the resolved plaintext values.
 *
 * Returns a list of keys that were resolved from the vault (for
 * audit logging).
 */
export function resolveVaultSecrets(rawEnv: NodeJS.ProcessEnv): string[] {
  const resolved: string[] = [];

  for (const key of VAULT_RESOLVABLE_KEYS) {
    const raw = rawEnv[key];
    if (!raw || !raw.startsWith(VAULT_PREFIX)) continue;

    const plaintext = resolveVaultSecret(raw, rawEnv);
    if (plaintext !== undefined) {
      rawEnv[key] = plaintext;
      resolved.push(key);
    } else {
      // Remove the VAULT: reference so validation treats it as unset
      delete rawEnv[key];
      resolved.push(key);
    }
  }

  return resolved;
}
