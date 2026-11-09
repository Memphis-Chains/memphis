/** Shared Node/native token reservations. No prompt or provider response is stored. */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import Database from 'better-sqlite3';

import { resolveInstallRoot } from './install-root.js';
import { AppError } from '../../core/errors.js';
import { validateOperatorPassphrase } from '../auth/operator-gate.js';

export interface BudgetCaps { daily?: number; monthly?: number }
export interface BudgetReservation { id: string; reservedTokens: number }

export function providerBudgetCaps(provider: string, env: NodeJS.ProcessEnv): BudgetCaps {
  const prefix = `MEMPHIS_COST_CAP_${provider.toUpperCase().replaceAll('-', '_')}`;
  const read = (suffix: string): number | undefined => {
    const raw = env[`${prefix}_${suffix}`]?.trim();
    if (!raw) return undefined;
    if (!/^[0-9]+$/.test(raw)) throw new Error(`invalid ${prefix}_${suffix}`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`invalid ${prefix}_${suffix}`);
    return value;
  };
  return { daily: read('DAILY_TOKENS'), monthly: read('MONTHLY_TOKENS') };
}

export function budgetDatabasePath(env: NodeJS.ProcessEnv): string {
  const url = env.DATABASE_URL ?? 'file:./data/memphis.db';
  if (!url.startsWith('file:')) throw new Error('provider budget requires a file: SQLite database');
  const file = url.slice(5);
  if (!file) throw new Error('provider budget database path is empty');
  return isAbsolute(file) ? file : resolve(resolveInstallRoot({ rawEnv: env }), file);
}

function open(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { timeout: 5000 });
  db.exec(`CREATE TABLE IF NOT EXISTS provider_budget_reservations (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, started_at TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('reserved','settled','unknown')),
    reserved_tokens INTEGER NOT NULL CHECK(reserved_tokens > 0),
    actual_tokens INTEGER CHECK(actual_tokens >= 0), settled_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_provider_budget_period ON provider_budget_reservations(provider, started_at);`);
  return db;
}

/** Reserve before dispatch, atomically with other processes using the same database. */
export function reserveProviderBudget(path: string, provider: string, reservedTokens: number,
  caps: BudgetCaps, now: Date = new Date()): BudgetReservation {
  if (!/^[a-z0-9_-]{1,80}$/i.test(provider) || !Number.isSafeInteger(reservedTokens) || reservedTokens <= 0)
    throw new Error('invalid provider budget reservation');
  for (const cap of [caps.daily, caps.monthly]) {
    if (cap !== undefined && (!Number.isSafeInteger(cap) || cap <= 0)) throw new Error('invalid provider budget cap');
  }
  const at = now.toISOString();
  const day = at.slice(0, 10);
  const month = at.slice(0, 7);
  const id = randomBytes(16).toString('hex');
  const db = open(path);
  try {
    return db.transaction(() => {
      const sums = db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN status!='settled' OR substr(started_at,1,10)=? THEN CASE WHEN status='settled' THEN actual_tokens ELSE reserved_tokens END ELSE 0 END),0) AS daily,
        COALESCE(SUM(CASE WHEN status!='settled' OR substr(started_at,1,7)=? THEN CASE WHEN status='settled' THEN actual_tokens ELSE reserved_tokens END ELSE 0 END),0) AS monthly
        FROM provider_budget_reservations WHERE provider=?`).get(day, month, provider) as { daily: number; monthly: number };
      if ((caps.daily !== undefined && sums.daily + reservedTokens > caps.daily) ||
          (caps.monthly !== undefined && sums.monthly + reservedTokens > caps.monthly)) {
        throw new AppError('PROVIDER_RATE_LIMIT', `provider ${provider} token budget has insufficient room for the next reservation`, 429, { source: 'provider-budget' });
      }
      db.prepare("INSERT INTO provider_budget_reservations(id,provider,started_at,status,reserved_tokens) VALUES (?,?,?,'reserved',?)")
        .run(id, provider, at, reservedTokens);
      return { id, reservedTokens };
    }).immediate();
  } finally { db.close(); }
}

/** Missing or estimated usage is not proof of cost; keep the whole reservation. */
export function settleProviderBudget(path: string, id: string, actualTokens?: number, estimated = false): void {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('invalid budget reservation id');
  const measured = actualTokens !== undefined && Number.isSafeInteger(actualTokens) && actualTokens >= 0 && !estimated;
  const db = open(path);
  try {
    const result = measured
      ? db.prepare("UPDATE provider_budget_reservations SET status='settled', actual_tokens=?, settled_at=? WHERE id=? AND status='reserved'")
        .run(actualTokens, new Date().toISOString(), id)
      : db.prepare("UPDATE provider_budget_reservations SET status='unknown', settled_at=? WHERE id=? AND status='reserved'")
        .run(new Date().toISOString(), id);
    if (result.changes !== 1) throw new Error('budget reservation is missing or already settled');
  } finally { db.close(); }
}

export interface PendingBudgetReservation {
  id: string; provider: string; startedAt: string; status: 'reserved' | 'unknown'; reservedTokens: number;
}

export interface BudgetLedgerSnapshot {
  available: boolean;
  coverage: 'recorded-reservations-only';
  providers: Array<{ provider: string; dailyTokens: number; monthlyTokens: number;
    pending: number; unknown: number; dailyCap?: number; monthlyCap?: number }>;
}

/** These totals start with ledger adoption; they do not include earlier usage. */
export function providerBudgetLedgerSnapshot(path: string, env: NodeJS.ProcessEnv,
  now: Date = new Date()): BudgetLedgerSnapshot {
  const empty: BudgetLedgerSnapshot = { available: false, coverage: 'recorded-reservations-only', providers: [] };
  if (!existsSync(path)) return empty;
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_budget_reservations'").get()) return empty;
    const at = now.toISOString();
    const rows = db.prepare(`SELECT provider,
      COALESCE(SUM(CASE WHEN status!='settled' OR substr(started_at,1,10)=? THEN CASE WHEN status='settled' THEN actual_tokens ELSE reserved_tokens END ELSE 0 END),0) AS dailyTokens,
      COALESCE(SUM(CASE WHEN status!='settled' OR substr(started_at,1,7)=? THEN CASE WHEN status='settled' THEN actual_tokens ELSE reserved_tokens END ELSE 0 END),0) AS monthlyTokens,
      SUM(CASE WHEN status='reserved' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status='unknown' THEN 1 ELSE 0 END) AS unknown
      FROM provider_budget_reservations GROUP BY provider ORDER BY provider`).all(at.slice(0,10), at.slice(0,7)) as BudgetLedgerSnapshot['providers'];
    return { available: true, coverage: 'recorded-reservations-only', providers: rows.map((row) => {
      const caps = providerBudgetCaps(row.provider, env);
      return { ...row, dailyCap: caps.daily, monthlyCap: caps.monthly };
    }) };
  } finally { db.close(); }
}

/** Lists metadata only; reserved can still belong to a live request. */
export function listPendingBudgetReservations(path: string): PendingBudgetReservation[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_budget_reservations'").get()) return [];
    return db.prepare("SELECT id,provider,started_at AS startedAt,status,reserved_tokens AS reservedTokens FROM provider_budget_reservations WHERE status IN ('reserved','unknown') ORDER BY started_at DESC LIMIT 100").all() as PendingBudgetReservation[];
  } finally { db.close(); }
}

/** Operator records confirmed usage; forcing a reserved row can race a live request. */
export function reconcileBudgetReservation(path: string, id: string, actualTokens: number,
  passphrase: string, forceRunning = false): void {
  if (!/^[a-f0-9]{32}$/.test(id) || !Number.isSafeInteger(actualTokens) || actualTokens < 0)
    throw new Error('invalid budget reconciliation');
  if (!passphrase || !validateOperatorPassphrase(passphrase)) throw new Error('operator authentication failed');
  const db = new Database(path, { fileMustExist: true, timeout: 5000 });
  try {
    db.exec("CREATE TABLE IF NOT EXISTS provider_budget_recovery_audit (reservation_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL, actual_tokens INTEGER NOT NULL, created_at TEXT NOT NULL)");
    db.transaction(() => {
      const at = new Date().toISOString();
      const states = forceRunning ? "IN ('unknown','reserved')" : "= 'unknown'";
      const result = db.prepare(`UPDATE provider_budget_reservations SET status='settled', actual_tokens=?, settled_at=? WHERE id=? AND status ${states}`)
        .run(actualTokens, at, id);
      if (result.changes !== 1) throw new Error('reservation is missing, settled, or may still be active; inspect before --force-running');
      db.prepare('INSERT INTO provider_budget_recovery_audit(reservation_id,action,actor,actual_tokens,created_at) VALUES(?,?,?,?,?)')
        .run(id, forceRunning ? 'reconcile-forced' : 'reconcile', 'local-operator', actualTokens, at);
    }).immediate();
  } finally { db.close(); }
}

/** The configured provider override can take precedence over a per-call value. */
export function providerOutputReservation(provider: string, model: string, requested: number | undefined,
  env: NodeJS.ProcessEnv): number {
  let max = requested;
  if (provider === 'minimax' && model.toLowerCase().includes('m3')) {
    const override = env.MINIMAX_MAX_COMPLETION_TOKENS?.trim();
    if (override) {
      if (!/^[0-9]+$/.test(override)) throw new Error('invalid MINIMAX_MAX_COMPLETION_TOKENS');
      max = Number(override);
    }
    max ??= 131_072;
  } else {
    max ??= provider === 'anthropic' || provider === 'ollama' ? 4096 : 2048;
  }
  if (!Number.isSafeInteger(max) || max <= 0 || max > 524_288) throw new Error('invalid provider output reservation');
  return max;
}

export async function withProviderBudget<T>(params: {
  provider: string; model: string; env: NodeJS.ProcessEnv; input: unknown; outputTokens?: number;
  invoke: (outputTokens: number | undefined) => Promise<T>;
  usage: (result: T) => { total?: number; estimated?: boolean } | undefined;
}): Promise<T> {
  const caps = providerBudgetCaps(params.provider, params.env);
  if (caps.daily === undefined && caps.monthly === undefined) return params.invoke(params.outputTokens);
  const output = providerOutputReservation(params.provider, params.model, params.outputTokens, params.env);
  const encoded = JSON.stringify(params.input);
  if (encoded === undefined) throw new Error('provider budget cannot estimate input');
  // Bytes are a deliberately conservative estimate, not an exact tokenizer.
  const reserved = Buffer.byteLength(encoded, 'utf8') + output + 1024;
  const path = budgetDatabasePath(params.env);
  const reservation = reserveProviderBudget(path, params.provider, reserved, caps);
  let result: T;
  try {
    result = await params.invoke(output);
  } catch (error) {
    // A rejected request may still have been billed. Preserve the reservation.
    try { settleProviderBudget(path, reservation.id); } catch { /* reservation remains reserved */ }
    throw error;
  }
  const usage = params.usage(result);
  settleProviderBudget(path, reservation.id, usage?.total, usage ? usage.estimated === true : true);
  return result;
}
