/**
 * Provider cost cap & budget observability (Phase 1.3 production sprint).
 *
 * "Memphis watches the bill so I don't have to."
 *
 * Without this, a bugged agent / runaway loop / prompt-injection attack
 * could trivially burn through the operator's Anthropic credits in
 * minutes. Rate limits at the HTTP layer protect Memphis from clients;
 * NOTHING was protecting the operator from Memphis.
 *
 * Approach (operator-friendly, NOT a nanny):
 *   - Per-provider rolling token counters keyed by day and month.
 *   - Operator sets MEMPHIS_COST_CAP_<PROVIDER>_DAILY_TOKENS / _MONTHLY.
 *     Both optional; unset = no cap (legacy behavior preserved).
 *   - On each provider call, increment the counter by inputTokens +
 *     outputTokens. Counters reset at day/month rollover.
 *   - Soft alerts at 50/75/90% — operator gets notified BEFORE the cap
 *     bites, so they can plan rather than react.
 *   - Hard cap at 100% — provider call throws CostCapExceededError so
 *     the cascade falls through to the next tier (local-fallback in the
 *     worst case). Operator sees a clear message, NOT silent failure.
 *   - Operator can bump caps at runtime via /config set
 *     (MEMPHIS_COST_CAP_*_DAILY_TOKENS is `hot`). Tier-3 not required
 *     because the operator setting their own budget is operational, not
 *     destructive.
 *   - /v1/ops/status surfaces the burn rate per provider. Grafana panel
 *     becomes a one-click "where's my budget going" view.
 */

import { AppError } from '../../core/errors.js';

export type CostCapDecision = {
  allowed: boolean;
  reason?:
    | 'no-cap-configured'
    | 'within-budget'
    | 'soft-warning-50'
    | 'soft-warning-75'
    | 'soft-warning-90'
    | 'cap-exceeded';
  provider: string;
  daily: { used: number; cap?: number; pctUsed?: number };
  monthly: { used: number; cap?: number; pctUsed?: number };
};

interface CounterRecord {
  dayKey: string;
  dayUsed: number;
  monthKey: string;
  monthUsed: number;
  /** Soft-warning thresholds already alerted in the current window
   * (so we don't spam the operator multiple times per cycle). */
  alertedSoft: Set<50 | 75 | 90>;
}

const counters = new Map<string, CounterRecord>();

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

function getOrCreate(provider: string, now: Date): CounterRecord {
  const existing = counters.get(provider);
  const today = dayKey(now);
  const thisMonth = monthKey(now);
  if (existing) {
    if (existing.dayKey !== today) {
      existing.dayKey = today;
      existing.dayUsed = 0;
      existing.alertedSoft.clear();
    }
    if (existing.monthKey !== thisMonth) {
      existing.monthKey = thisMonth;
      existing.monthUsed = 0;
      existing.alertedSoft.clear();
    }
    return existing;
  }
  const fresh: CounterRecord = {
    dayKey: today,
    dayUsed: 0,
    monthKey: thisMonth,
    monthUsed: 0,
    alertedSoft: new Set(),
  };
  counters.set(provider, fresh);
  return fresh;
}

function envKey(provider: string, suffix: 'DAILY_TOKENS' | 'MONTHLY_TOKENS'): string {
  // anthropic → MEMPHIS_COST_CAP_ANTHROPIC_DAILY_TOKENS
  return `MEMPHIS_COST_CAP_${provider.toUpperCase().replaceAll('-', '_')}_${suffix}`;
}

function readCap(
  rawEnv: NodeJS.ProcessEnv,
  provider: string,
  suffix: 'DAILY_TOKENS' | 'MONTHLY_TOKENS',
): number | undefined {
  const raw = rawEnv[envKey(provider, suffix)]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

/**
 * Record token usage for a provider call. Returns the decision outcome
 * for the NEXT call (so the caller can surface a soft-warning back to
 * the operator UI). Does NOT throw — recording is non-destructive.
 */
export function recordProviderUsage(
  provider: string,
  inputTokens: number,
  outputTokens: number,
  rawEnv: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): CostCapDecision {
  const total = (inputTokens || 0) + (outputTokens || 0);
  const rec = getOrCreate(provider, now);
  rec.dayUsed += total;
  rec.monthUsed += total;
  return queryProviderBudget(provider, rawEnv, now);
}

/**
 * Read-only check: would the next call exceed the cap? Used by the
 * provider adapter to decide whether to reject before spending the
 * tokens. Returns CostCapDecision; throws when allowed=false.
 */
export function checkProviderBudget(
  provider: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): CostCapDecision {
  const decision = queryProviderBudget(provider, rawEnv, now);
  if (!decision.allowed) {
    throw new AppError(
      'PROVIDER_RATE_LIMIT',
      `provider ${provider} budget cap exceeded — daily ${decision.daily.used}/${decision.daily.cap ?? '∞'}, monthly ${decision.monthly.used}/${decision.monthly.cap ?? '∞'}. Cascade will fall through to the next tier.`,
      429,
      {
        provider,
        decision,
      },
    );
  }
  return decision;
}

export function queryProviderBudget(
  provider: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): CostCapDecision {
  const dailyCap = readCap(rawEnv, provider, 'DAILY_TOKENS');
  const monthlyCap = readCap(rawEnv, provider, 'MONTHLY_TOKENS');
  const rec = getOrCreate(provider, now);
  const dailyPct = dailyCap ? rec.dayUsed / dailyCap : undefined;
  const monthlyPct = monthlyCap ? rec.monthUsed / monthlyCap : undefined;
  const dailyExceeded = dailyCap !== undefined && rec.dayUsed >= dailyCap;
  const monthlyExceeded = monthlyCap !== undefined && rec.monthUsed >= monthlyCap;
  const exceeded = dailyExceeded || monthlyExceeded;

  let reason: CostCapDecision['reason'] = 'no-cap-configured';
  if (dailyCap !== undefined || monthlyCap !== undefined) {
    if (exceeded) {
      reason = 'cap-exceeded';
    } else {
      const worst = Math.max(dailyPct ?? 0, monthlyPct ?? 0);
      if (worst >= 0.9) reason = 'soft-warning-90';
      else if (worst >= 0.75) reason = 'soft-warning-75';
      else if (worst >= 0.5) reason = 'soft-warning-50';
      else reason = 'within-budget';
    }
  }

  return {
    allowed: !exceeded,
    reason,
    provider,
    daily: {
      used: rec.dayUsed,
      cap: dailyCap,
      pctUsed: dailyPct === undefined ? undefined : Math.round(dailyPct * 1000) / 1000,
    },
    monthly: {
      used: rec.monthUsed,
      cap: monthlyCap,
      pctUsed: monthlyPct === undefined ? undefined : Math.round(monthlyPct * 1000) / 1000,
    },
  };
}

/**
 * After a usage record, check if we just crossed a soft-warning
 * threshold (50/75/90) — call this from the provider adapter to fire
 * a one-shot alert. Returns the threshold level just crossed, or null
 * if no new threshold was crossed.
 */
export function consumeSoftWarning(
  provider: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): 50 | 75 | 90 | null {
  const decision = queryProviderBudget(provider, rawEnv, now);
  if (decision.allowed === false) return null; // cap-exceeded handled separately
  const worst = Math.max(decision.daily.pctUsed ?? 0, decision.monthly.pctUsed ?? 0);
  const rec = getOrCreate(provider, now);
  for (const threshold of [90, 75, 50] as const) {
    if (worst >= threshold / 100 && !rec.alertedSoft.has(threshold)) {
      rec.alertedSoft.add(threshold);
      return threshold;
    }
  }
  return null;
}

/** Snapshot of all providers — for /status payload. */
export function getAllProviderBudgets(
  rawEnv: NodeJS.ProcessEnv = process.env,
  now: Date = new Date(),
): CostCapDecision[] {
  const out: CostCapDecision[] = [];
  for (const provider of counters.keys()) {
    out.push(queryProviderBudget(provider, rawEnv, now));
  }
  return out;
}

/** Test-only: clear all counters. */
export function __resetCostCapForTests(): void {
  counters.clear();
}
