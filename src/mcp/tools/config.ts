import {
  performHotReload,
  redactFieldValue,
  type HotReloadResult,
} from '../../infra/config/hot-reload.js';
import {
  classifyField,
  listKnownFields,
  type MutabilityTier,
} from '../../infra/config/mutability.js';

export interface MemphisConfigShowOutput {
  fields: Array<{ key: string; tier: MutabilityTier }>;
  values: Record<string, string>;
  requestedKey: string | null;
  /** Set when the caller asked for a key not in the known-fields whitelist. */
  unknownKey?: string;
}

/**
 * Redacted view of the current hot-reloadable env surface.
 *
 * **Whitelist enforcement (Codex P1 fix):** when `input.key` is supplied,
 * it must appear in `listKnownFields()` — i.e., a key actually defined in
 * `envSchema` and classified in `mutability.ts`. Without this whitelist,
 * a caller could pass any env var name (e.g. an operator-only legacy
 * credential not tracked in the schema) and the response would echo the
 * value verbatim because `redactFieldValue` only masks keys it knows are
 * `secret`. Defense-in-depth: this tool is for inspecting Memphis runtime
 * config, not for arbitrary `process.env` exfiltration.
 */
export function runMemphisConfigShow(input: { key?: string } = {}): MemphisConfigShowOutput {
  const fields = listKnownFields();
  const knownKeySet = new Set(fields.map((f) => f.key));

  if (input.key !== undefined && !knownKeySet.has(input.key)) {
    return {
      fields,
      values: {},
      requestedKey: input.key,
      unknownKey: input.key,
    };
  }

  const targetKeys = input.key ? [input.key] : fields.map((f) => f.key);
  const values: Record<string, string> = {};
  for (const name of targetKeys) {
    const raw = process.env[name];
    if (raw === undefined) continue;
    values[name] = redactFieldValue(name, raw);
  }
  return { fields, values, requestedKey: input.key ?? null };
}

export interface MemphisConfigReloadOutput extends HotReloadResult {
  /** Surface-parity convenience: classification of every key in the diff. */
  classification: Array<{ key: string; tier: MutabilityTier }>;
}

/**
 * Re-read `.env`, validate, swap hot/warm fields; refuse cold fields.
 * Returns the redacted result.
 */
export async function runMemphisConfigReload(): Promise<MemphisConfigReloadOutput> {
  const result = await performHotReload();
  const classification = result.changes.map((c) => ({
    key: c.key,
    tier: classifyField(c.key),
  }));
  return { ...result, classification };
}
