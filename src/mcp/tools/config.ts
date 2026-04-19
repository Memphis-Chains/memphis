import { loadOperatorConfig, validateOperatorPassphrase } from '../../infra/auth/operator-gate.js';
import { setDotEnvValues } from '../../infra/config/dotenv-file.js';
import {
  performHotReload,
  redactFieldValue,
  type HotReloadResult,
} from '../../infra/config/hot-reload.js';
import {
  classifyField,
  listKnownFields,
  requiresElevatedTier,
  requiresRestart,
  type MutabilityTier,
} from '../../infra/config/mutability.js';
import { envSchema } from '../../infra/config/schema.js';

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

export type MemphisConfigSetOutcome =
  | {
      ok: true;
      key: string;
      tier: MutabilityTier;
      newValue: string;
    }
  | {
      ok: false;
      reason:
        | 'cold-field'
        | 'secret-no-passphrase'
        | 'secret-bad-passphrase'
        | 'validation-failed'
        | 'unknown-key'
        | 'rate-limited';
      key: string;
      tier?: MutabilityTier;
      message: string;
    };

/**
 * Closes deferred item #7: MCP config.set with the one-shot passphrase
 * pattern proven on `memphis_restart`.
 *
 * Gating matches the HTTP /v1/ops/config/set semantics exactly:
 *   - cold fields → refuse with 'cold-field' (operator must restart)
 *   - secret fields → require `passphrase` input; validate against operator
 *     gate; refuse with 'secret-bad-passphrase' on mismatch. When no
 *     operator config is set yet (first-run) secret writes are still
 *     permitted — there's nothing to authenticate against.
 *   - hot/warm fields → apply without passphrase (unprivileged layer)
 *
 * The `redactFields: ['passphrase', 'value']` registration in server.ts
 * keeps both the operator credential AND the new config value out of the
 * approvals table.
 */
export function runMemphisConfigSet(input: {
  key?: string;
  value?: string;
  passphrase?: string;
}): MemphisConfigSetOutcome {
  const key = typeof input.key === 'string' ? input.key.trim() : '';
  const value = typeof input.value === 'string' ? input.value : '';
  if (!key) {
    return {
      ok: false,
      reason: 'validation-failed',
      key: '',
      message: 'config.set requires `key`',
    };
  }
  if (value.includes('\n') || value.includes('\r')) {
    return {
      ok: false,
      reason: 'validation-failed',
      key,
      message: 'value must not contain newline characters',
    };
  }

  const tier = classifyField(key);
  const fields = listKnownFields();
  if (!fields.some((f) => f.key === key)) {
    return {
      ok: false,
      reason: 'unknown-key',
      key,
      message: `unknown config key: ${key}`,
    };
  }

  if (requiresRestart(key)) {
    return {
      ok: false,
      reason: 'cold-field',
      key,
      tier,
      message: `cold field — restart required to change ${key}`,
    };
  }

  if (requiresElevatedTier(key)) {
    // Secret field — require the operator passphrase unless the operator
    // hasn't set one yet (first-run state).
    if (loadOperatorConfig(process.env)) {
      if (!input.passphrase) {
        return {
          ok: false,
          reason: 'secret-no-passphrase',
          key,
          tier,
          message: `secret field — operator passphrase required to change ${key}`,
        };
      }
      try {
        if (!validateOperatorPassphrase(input.passphrase, process.env)) {
          return {
            ok: false,
            reason: 'secret-bad-passphrase',
            key,
            tier,
            message: 'operator passphrase did not validate',
          };
        }
      } catch (err) {
        return {
          ok: false,
          reason: 'rate-limited',
          key,
          tier,
          message: err instanceof Error ? err.message : 'passphrase check failed',
        };
      }
    }
  }

  const schema = envSchema.partial();
  const candidate = { ...process.env, [key]: value };
  const parsed = schema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues.find((i) => i.path.includes(key));
    return {
      ok: false,
      reason: 'validation-failed',
      key,
      tier,
      message: `validation failed: ${issue?.message ?? 'invalid value'}`,
    };
  }

  setDotEnvValues({ [key]: value }, process.env);
  process.env[key] = value;

  return {
    ok: true,
    key,
    tier,
    newValue: redactFieldValue(key, value),
  };
}

export type MemphisCognitiveModeSetOutcome =
  | {
      ok: true;
      previousMode: 'A' | 'B' | 'C' | 'D' | 'E';
      newMode: 'A' | 'B' | 'C' | 'D' | 'E';
    }
  | {
      ok: false;
      reason: 'no-passphrase' | 'bad-passphrase' | 'invalid-mode' | 'rate-limited';
      message: string;
    };

/**
 * Cognitive mode set via MCP. Modes A–E map to different reasoning
 * orientations (see src/cognitive/model-*.ts) — a significant mental
 * state change, so the one-shot passphrase pattern applies.
 */
export async function runMemphisCognitiveModeSet(input: {
  mode?: string;
  passphrase?: string;
}): Promise<MemphisCognitiveModeSetOutcome> {
  const mode = typeof input.mode === 'string' ? input.mode.trim().toUpperCase() : '';
  if (!['A', 'B', 'C', 'D', 'E'].includes(mode)) {
    return {
      ok: false,
      reason: 'invalid-mode',
      message: 'cognitive mode must be one of A, B, C, D, E',
    };
  }

  if (loadOperatorConfig(process.env)) {
    if (!input.passphrase) {
      return {
        ok: false,
        reason: 'no-passphrase',
        message: 'operator passphrase required to change cognitive mode',
      };
    }
    try {
      if (!validateOperatorPassphrase(input.passphrase, process.env)) {
        return {
          ok: false,
          reason: 'bad-passphrase',
          message: 'operator passphrase did not validate',
        };
      }
    } catch (err) {
      return {
        ok: false,
        reason: 'rate-limited',
        message: err instanceof Error ? err.message : 'passphrase check failed',
      };
    }
  }

  const { getCognitiveMode, setCognitiveMode } = await import('../../soul/manifest.js');
  const previousMode = (getCognitiveMode(process.env) ?? 'A') as 'A' | 'B' | 'C' | 'D' | 'E';
  setCognitiveMode(mode as 'A' | 'B' | 'C' | 'D' | 'E', process.env);
  return {
    ok: true,
    previousMode,
    newMode: mode as 'A' | 'B' | 'C' | 'D' | 'E',
  };
}
