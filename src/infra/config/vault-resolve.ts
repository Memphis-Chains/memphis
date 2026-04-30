import { useVaultSecretByKey } from '../../security/vault-boundary.js';

const VAULT_PREFIX = 'VAULT:';

/**
 * Resolve a config value that may reference a vault secret.
 *
 * If the value starts with "VAULT:<key_name>", the latest vault entry
 * for that key is resolved through the vault boundary and returned.
 * Otherwise the value is returned as-is.
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

  const result = useVaultSecretByKey(
    keyName,
    { surface: 'system', route: 'config:vault-resolve' },
    rawEnv,
  );
  if (!result.found) {
    console.warn(
      `[memphis-config] VAULT:${keyName} referenced but no vault entry found for key "${keyName}"`,
    );
    return undefined;
  }

  if (result.error) {
    console.warn(`[memphis-config] VAULT:${keyName} resolution failed: ${result.error}`);
    return undefined;
  }

  return result.plaintext;
}

/**
 * List of env keys that support VAULT: prefix resolution.
 */
const VAULT_RESOLVABLE_KEYS = [
  'SHARED_LLM_API_KEY',
  'DECENTRALIZED_LLM_API_KEY',
  'RUST_EMBED_PROVIDER_API_KEY',
  'MINIMAX_API_KEY',
  'DEEPSEEK_API_KEY',
  'GLM_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENAI_COMPATIBLE_API_KEY',
  'MEMPHIS_TELEGRAM_BOT_TOKEN',
  'MEMPHIS_TELEGRAM_ALLOWED_USER_IDS',
  'MEMPHIS_API_TOKEN',
  'PINATA_API_KEY',
  'PINATA_SECRET_API_KEY',
  'MEMPHIS_ALERT_PAGERDUTY_ROUTING_KEY',
  'MEMPHIS_ALERT_OPSGENIE_API_KEY',
] as const;

/**
 * Resolve all VAULT: prefixed values in the raw env before config
 * parsing. Mutates the provided env object so that Zod schema
 * validation sees the resolved plaintext values.
 *
 * Returns a list of keys that were resolved from the vault (for
 * audit logging).
 */
export interface VaultResolveResult {
  /** Env keys whose VAULT:<key> reference decrypted successfully and
   * was overwritten with the plaintext. */
  resolved: string[];
  /** Env keys whose VAULT:<key> reference failed to decrypt (entry
   * missing, wrong passphrase, corrupted ciphertext). The env var has
   * been *removed* (set to undefined) so downstream Zod validation
   * sees a clean "missing" state and emits its own clear error. */
  failed: string[];
}

export function resolveVaultSecrets(rawEnv: NodeJS.ProcessEnv): VaultResolveResult {
  const resolved: string[] = [];
  const failed: string[] = [];

  for (const key of VAULT_RESOLVABLE_KEYS) {
    const raw = rawEnv[key];
    if (!raw || !raw.startsWith(VAULT_PREFIX)) continue;

    const plaintext = resolveVaultSecret(raw, rawEnv);
    if (plaintext !== undefined) {
      rawEnv[key] = plaintext;
      resolved.push(key);
    } else {
      // Remove the VAULT: reference so validation treats it as unset.
      // Issue #276: previously this branch also pushed to `resolved`,
      // making the log say "Resolved N secret(s) from vault: KEY" even
      // when KEY actually failed to decrypt. Operators saw the success
      // line, then a Zod error claiming KEY is missing — and wasted
      // 20+ minutes debugging Zod before realizing it was a vault
      // failure. Tracking failures as a distinct list lets callers
      // emit honest "resolved X / failed Y" telemetry.
      delete rawEnv[key];
      failed.push(key);
    }
  }

  return { resolved, failed };
}
