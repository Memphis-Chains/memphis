import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hashWithSalt, saveOperatorConfig } from '../../src/infra/auth/operator-gate.js';
import { listPendingBudgetReservations, providerBudgetCaps, providerBudgetLedgerSnapshot, reconcileBudgetReservation, reserveProviderBudget, settleProviderBudget, withProviderBudget } from '../../src/infra/runtime/provider-budget-ledger.js';

const fixture = (): string => join(mkdtempSync(join(tmpdir(), 'memphis-budget-')), 'state.db');

describe('durable provider budget ledger', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('reserves before dispatch and settles measured use once', () => {
    const path = fixture();
    const first = reserveProviderBudget(path, 'minimax', 80, { daily: 100 });
    expect(() => reserveProviderBudget(path, 'minimax', 21, { daily: 100 })).toThrow(/insufficient/);
    settleProviderBudget(path, first.id, 20);
    expect(reserveProviderBudget(path, 'minimax', 80, { daily: 100 })).toBeDefined();
    expect(() => settleProviderBudget(path, first.id, 10)).toThrow(/already settled/);
  });

  it('keeps a failed or estimated reservation charged even after reopening', () => {
    const path = fixture();
    const first = reserveProviderBudget(path, 'minimax', 80, { daily: 100 });
    settleProviderBudget(path, first.id, 12, true);
    expect(() => reserveProviderBudget(path, 'minimax', 21, { daily: 100 })).toThrow(/insufficient/);
    const db = new Database(path, { readonly: true });
    expect(db.prepare('select status,actual_tokens from provider_budget_reservations where id=?').get(first.id))
      .toEqual({ status: 'unknown', actual_tokens: null });
    db.close();
  });

  it('keeps unresolved reservations across UTC rollover until settled', () => {
    const path = fixture();
    const first = reserveProviderBudget(path, 'minimax', 80, { daily: 100, monthly: 100 }, new Date('2026-04-30T23:59:59Z'));
    expect(() => reserveProviderBudget(path, 'minimax', 21, { monthly: 100 }, new Date('2026-04-30T23:59:59Z'))).toThrow();
    expect(() => reserveProviderBudget(path, 'minimax', 21, { daily: 100, monthly: 100 }, new Date('2026-05-01T00:00:00Z'))).toThrow();
    const db = new Database(path, { readonly: true });
    expect(db.prepare('select status from provider_budget_reservations where id=?').get(first.id)).toEqual({ status: 'reserved' });
    db.close();
    settleProviderBudget(path, first.id, 80);
    expect(reserveProviderBudget(path, 'minimax', 100, { daily: 100, monthly: 100 }, new Date('2026-05-01T00:00:00Z'))).toBeDefined();
  });

  it('rejects malformed configured caps rather than silently disabling them', () => {
    expect(() => providerBudgetCaps('minimax', { MEMPHIS_COST_CAP_MINIMAX_DAILY_TOKENS: 'oops' })).toThrow(/invalid/);
    expect(providerBudgetCaps('minimax', { MEMPHIS_COST_CAP_MINIMAX_DAILY_TOKENS: '500' }).daily).toBe(500);
  });

  it('reserves each call and settles verified usage without storing request text', async () => {
    const path = fixture();
    const env = { DATABASE_URL: `file:${path}`, MEMPHIS_COST_CAP_MINIMAX_DAILY_TOKENS: '5000' };
    const params = { provider: 'minimax', model: 'legacy', env, input: { prompt: 'private request' }, outputTokens: 1000,
      invoke: async (limit: number | undefined) => ({ usage: { totalTokens: 17 }, limit }),
      usage: (result: { usage: { totalTokens: number } }) => ({ total: result.usage.totalTokens }),
    };
    expect((await withProviderBudget(params)).limit).toBe(1000);
    await withProviderBudget(params);
    const db = new Database(path, { readonly: true });
    const rows = db.prepare('select status,actual_tokens from provider_budget_reservations').all();
    expect(rows).toEqual([{status: 'settled', actual_tokens: 17}, {status: 'settled', actual_tokens: 17}]);
    expect(JSON.stringify(db.prepare('select * from provider_budget_reservations').all())).not.toContain('private request');
    db.close();
  });

  it('keeps a reservation after dispatch fails and leaves uncapped calls unchanged', async () => {
    const path = fixture();
    const env = { DATABASE_URL: `file:${path}`, MEMPHIS_COST_CAP_MINIMAX_DAILY_TOKENS: '3000' };
    const params = { provider: 'minimax', model: 'legacy', env, input: {}, outputTokens: 1500,
      invoke: async () => { throw new Error('synthetic failure'); }, usage: () => undefined };
    await expect(withProviderBudget(params)).rejects.toThrow('synthetic failure');
    await expect(withProviderBudget(params)).rejects.toThrow(/insufficient/);
    const result = await withProviderBudget({ ...params, env: {}, outputTokens: undefined,
      invoke: async (limit) => limit, usage: () => undefined });
    expect(result).toBeUndefined();
  });

  it('requires the operator to reconcile an uncertain reservation and records the decision', () => {
    const path = fixture();
    vi.stubEnv('MEMPHIS_DATA_DIR', dirnameForFixture(path));
    const password = 'synthetic-operator-passphrase';
    const salt = 'synthetic-salt';
    saveOperatorConfig({ schemaVersion: 1, passphraseHash: hashWithSalt(password, salt), salt,
      createdAt: '', updatedAt: '', recoveryQuestionHint: '', recoveryHash: '' });
    const first = reserveProviderBudget(path, 'minimax', 80, { daily: 100 });
    expect(listPendingBudgetReservations(path)).toHaveLength(1);
    expect(() => reconcileBudgetReservation(path, first.id, 10, 'wrong')).toThrow(/authentication/);
    expect(() => reconcileBudgetReservation(path, first.id, 10, password)).toThrow(/active/);
    settleProviderBudget(path, first.id);
    reconcileBudgetReservation(path, first.id, 10, password);
    expect(listPendingBudgetReservations(path)).toEqual([]);
    const db = new Database(path, { readonly: true });
    expect(db.prepare('select action,actor,actual_tokens from provider_budget_recovery_audit').all())
      .toEqual([{ action: 'reconcile', actor: 'local-operator', actual_tokens: 10 }]);
    db.close();
    expect(reserveProviderBudget(path, 'minimax', 90, { daily: 100 })).toBeDefined();
  });

  it('reports confirmed and uncertain usage as recorded ledger coverage, not lifetime spend', () => {
    const path = fixture();
    const env = { MEMPHIS_COST_CAP_MINIMAX_DAILY_TOKENS: '1000' };
    const date = new Date('2026-11-08T12:00:00Z');
    const exact = reserveProviderBudget(path, 'minimax', 80, { daily: 1000 }, date);
    settleProviderBudget(path, exact.id, 20);
    const unknown = reserveProviderBudget(path, 'minimax', 30, { daily: 1000 }, date);
    settleProviderBudget(path, unknown.id);
    expect(providerBudgetLedgerSnapshot(path, env, date)).toEqual({
      available: true, coverage: 'recorded-reservations-only', providers: [{
        provider: 'minimax', dailyTokens: 50, monthlyTokens: 50, pending: 0, unknown: 1,
        dailyCap: 1000, monthlyCap: undefined,
      }],
    });
  });
});

function dirnameForFixture(path: string): string { return join(path, '..'); }
