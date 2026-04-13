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
}

/** Redacted view of the current hot-reloadable env surface. */
export function runMemphisConfigShow(input: { key?: string } = {}): MemphisConfigShowOutput {
  const fields = listKnownFields();
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
