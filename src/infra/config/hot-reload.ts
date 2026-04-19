/**
 * Hot-reload engine for Sprint 6.
 *
 * Responsibilities:
 * - Read the current `.env` from disk and parse it into a key/value map.
 * - Validate the diff against `envSchema` so we never let an invalid value
 *   into `process.env`.
 * - Classify each changed key via `mutability.ts`. Hot/warm swaps land in
 *   `process.env`; cold keys are rejected and listed back to the caller.
 * - Redact secret values in the returned diff so HTTP responses and audit
 *   logs never echo API keys back.
 *
 * This engine is deliberately pure w.r.t. side-effects on subsystems — it
 * only mutates `process.env` and delegates any per-subsystem re-init to the
 * caller. That keeps the reload path predictable and easy to test.
 */

import { existsSync, readFileSync } from 'node:fs';

import { resolveDotEnvPath } from './dotenv-file.js';
import { classifyField, type MutabilityTier } from './mutability.js';
import { runPostApplyHooks, type PostApplyHookOutcome } from './post-apply-hooks.js';
import { envSchema } from './schema.js';

export type FieldChangeStatus = 'applied' | 'rejected-cold' | 'unchanged' | 'invalid';

export interface FieldChange {
  key: string;
  tier: MutabilityTier;
  status: FieldChangeStatus;
  oldValue?: string;
  newValue?: string;
  reason?: string;
}

export interface HotReloadResult {
  ok: boolean;
  envPath: string;
  changes: FieldChange[];
  appliedCount: number;
  rejectedColdCount: number;
  unchangedCount: number;
  invalidCount: number;
  rejectedCold: string[];
  validationError?: string;
  /**
   * Outcomes from any subsystem post-apply hooks fired after the env swap
   * (Sprint: provider hot-swap). Empty when no hooks were registered for
   * any of the changed keys.
   */
  hookOutcomes?: PostApplyHookOutcome[];
}

export interface HotReloadOptions {
  /** Allow cold fields to be accepted — always false in production. */
  allowCold?: boolean;
  /** Optional override of the env object used for diffing. Defaults to `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** When true, treat secret fields as visible in the diff (tier-3 only). */
  includeSecretValues?: boolean;
}

const SECRET_REDACTION = '***redacted***';

export function redactFieldValue(key: string, value: string | undefined): string {
  if (value === undefined || value === null || value === '') return '';
  if (classifyField(key) === 'secret') return SECRET_REDACTION;
  return value;
}

/** Minimal `.env` parser — matches the shape written by `setDotEnvValues`. */
function parseDotEnvFile(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trimStart();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function readDotEnvFile(rawEnv: NodeJS.ProcessEnv = process.env): {
  path: string;
  values: Record<string, string>;
} {
  const path = resolveDotEnvPath(rawEnv);
  if (!existsSync(path)) return { path, values: {} };
  const text = readFileSync(path, 'utf8');
  return { path, values: parseDotEnvFile(text) };
}

function computeFieldChange(
  key: string,
  baseValue: string | undefined,
  incomingValue: string | undefined,
  allowCold: boolean,
): FieldChange {
  const tier = classifyField(key);
  const normalizedBase = baseValue ?? '';
  const normalizedNew = incomingValue ?? '';

  if (normalizedBase === normalizedNew) {
    return { key, tier, status: 'unchanged' };
  }

  if (tier === 'cold' && !allowCold) {
    return {
      key,
      tier,
      status: 'rejected-cold',
      oldValue: baseValue,
      newValue: incomingValue,
      reason: 'cold field — restart required',
    };
  }

  return {
    key,
    tier,
    status: 'applied',
    oldValue: baseValue,
    newValue: incomingValue,
  };
}

function validateIncoming(
  merged: Record<string, string | undefined>,
): { ok: true } | { ok: false; message: string } {
  const parsed = envSchema.safeParse(merged);
  if (parsed.success) return { ok: true };
  const first = parsed.error.issues[0];
  const location = first?.path.map(String).join('.') || 'unknown';
  return {
    ok: false,
    message: `${location}: ${first?.message ?? 'invalid value'}`,
  };
}

export function computeReloadPlan(options: HotReloadOptions = {}): HotReloadResult {
  const baseEnv = options.baseEnv ?? process.env;
  const allowCold = options.allowCold === true;
  const { path: envPath, values: fileValues } = readDotEnvFile(baseEnv);

  const changes: FieldChange[] = [];

  for (const [key, newValue] of Object.entries(fileValues)) {
    const oldValue = baseEnv[key];
    changes.push(computeFieldChange(key, oldValue, newValue, allowCold));
  }

  const applied = changes.filter((c) => c.status === 'applied');
  if (applied.length > 0) {
    const merged: Record<string, string | undefined> = { ...baseEnv };
    for (const change of applied) {
      merged[change.key] = change.newValue;
    }
    const validation = validateIncoming(merged);
    if (!validation.ok) {
      return {
        ok: false,
        envPath,
        changes: changes.map((c) =>
          c.status === 'applied' ? { ...c, status: 'invalid', reason: validation.message } : c,
        ),
        appliedCount: 0,
        rejectedColdCount: changes.filter((c) => c.status === 'rejected-cold').length,
        unchangedCount: changes.filter((c) => c.status === 'unchanged').length,
        invalidCount: applied.length,
        rejectedCold: changes.filter((c) => c.status === 'rejected-cold').map((c) => c.key),
        validationError: validation.message,
      };
    }
  }

  const rejectedCold = changes.filter((c) => c.status === 'rejected-cold').map((c) => c.key);

  return {
    ok: rejectedCold.length === 0,
    envPath,
    changes,
    appliedCount: changes.filter((c) => c.status === 'applied').length,
    rejectedColdCount: rejectedCold.length,
    unchangedCount: changes.filter((c) => c.status === 'unchanged').length,
    invalidCount: 0,
    rejectedCold,
  };
}

export interface ApplyReloadOptions extends HotReloadOptions {
  /** Dry run — compute the plan but don't mutate `process.env`. */
  dryRun?: boolean;
}

export function applyReloadPlan(
  plan: HotReloadResult,
  options: ApplyReloadOptions = {},
): { applied: string[]; skipped: string[] } {
  const applied: string[] = [];
  const skipped: string[] = [];
  if (options.dryRun === true) {
    for (const change of plan.changes) {
      if (change.status === 'applied') applied.push(change.key);
      else skipped.push(change.key);
    }
    return { applied, skipped };
  }
  if (!plan.ok) {
    for (const change of plan.changes) skipped.push(change.key);
    return { applied, skipped };
  }
  for (const change of plan.changes) {
    if (change.status !== 'applied') {
      skipped.push(change.key);
      continue;
    }
    if (change.newValue === undefined || change.newValue === '') {
      delete process.env[change.key];
    } else {
      process.env[change.key] = change.newValue;
    }
    applied.push(change.key);
  }
  return { applied, skipped };
}

export function redactReloadResult(result: HotReloadResult): HotReloadResult {
  return {
    ...result,
    changes: result.changes.map((change) => ({
      ...change,
      oldValue: redactFieldValue(change.key, change.oldValue),
      newValue: redactFieldValue(change.key, change.newValue),
    })),
  };
}

/**
 * Coordinated reload: read `.env` from disk, classify, validate, diff, apply,
 * fire any registered subsystem hooks. Returns a redacted result ready to hand
 * to HTTP/TUI/Telegram/MCP callers.
 */
export async function performHotReload(options: HotReloadOptions = {}): Promise<HotReloadResult> {
  const plan = computeReloadPlan(options);
  if (!plan.ok) return redactReloadResult(plan);
  applyReloadPlan(plan, options);
  const hookOutcomes = await runPostApplyHooks({
    changes: plan.changes
      .filter((c) => c.status === 'applied')
      .map((c) => ({ key: c.key, oldValue: c.oldValue, newValue: c.newValue })),
    rawEnv: options.baseEnv ?? process.env,
  });
  const enrichedPlan: HotReloadResult = {
    ...plan,
    hookOutcomes: hookOutcomes.length > 0 ? hookOutcomes : undefined,
  };
  return redactReloadResult(enrichedPlan);
}

/**
 * Synchronous variant for callers that can't await (existing TUI host
 * pattern, for instance). Skips post-apply hooks; the caller is on the
 * hook for not having any cache-bound fields in the change set.
 */
export function performHotReloadSync(options: HotReloadOptions = {}): HotReloadResult {
  const plan = computeReloadPlan(options);
  if (!plan.ok) return redactReloadResult(plan);
  applyReloadPlan(plan, options);
  return redactReloadResult(plan);
}

/** Redact a bare `process.env`-style value map, matching classification. */
export function redactEnvMap(map: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    if (value === undefined) continue;
    out[key] = redactFieldValue(key, value);
  }
  return out;
}

/** Snapshot of the current env (redacted), scoped to a key list if supplied. */
export function snapshotRedactedEnv(
  rawEnv: NodeJS.ProcessEnv = process.env,
  keys?: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  const source = keys ? keys : Object.keys(rawEnv);
  for (const key of source) {
    const value = rawEnv[key];
    if (value === undefined) continue;
    out[key] = redactFieldValue(key, value);
  }
  return out;
}
