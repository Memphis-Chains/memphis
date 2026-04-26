/**
 * Detects an unresolved vault reference like `VAULT:huggingface_api_token`.
 *
 * The memphis-config layer expands `VAULT:<key>` strings into actual secret
 * values at startup. If the vault entry is missing (or the vault is locked,
 * or the env was loaded before vault was unlocked), the config layer logs
 * a warning but leaves the literal `VAULT:...` string in the env var.
 *
 * Treating that literal as a real secret is what produced the 2026-04-20
 * Telegram crash loop (PR #285 / S2.5): the bot's getMe() returned 404
 * because the API token sent to Telegram was the literal "VAULT:telegram_bot_token"
 * string. Same pattern reproduces wherever code reads a env var that might
 * carry a vault ref (HUGGINGFACE_API_TOKEN, GOOGLE_TTS_API_KEY,
 * MEMPHIS_API_TOKEN, etc.) — every such call site must filter before use.
 *
 * Originally lived as a private helper in `gateway/channels/telegram-readiness.ts`;
 * lifted here so other surfaces can reuse without duplicating the regex.
 */
export function isUnresolvedVaultRef(value: string): boolean {
  return /^VAULT:/i.test(value);
}

/**
 * Returns the trimmed value if it's a real secret, or `null` if the slot is
 * empty/whitespace OR carries an unresolved `VAULT:` literal. Useful as a
 * drop-in replacement for `rawEnv.X?.trim()` at every secret-reading site.
 */
export function readResolvedSecret(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  if (isUnresolvedVaultRef(trimmed)) return null;
  return trimmed;
}
