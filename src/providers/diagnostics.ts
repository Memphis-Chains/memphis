import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';

import { MinimaxProvider, resolveProviderKeyResult } from './index.js';
import { ProviderHttpError } from './request-error.js';
import { getDataDir } from '../config/paths.js';
import { writeSecurityAudit } from '../infra/logging/security-audit.js';

export type ProbeOutcome = 'usable' | 'generated' | 'not-configured' | 'credential-error' | 'unsupported' | 'destination-denied' | 'unauthorized' | 'forbidden' | 'rate-limited' | 'model-or-endpoint-not-found' | 'bad-request' | 'provider-error' | 'network-error' | 'timeout' | 'cancelled' | 'invalid-response';
export interface ProviderProbeResult {
  provider: string;
  verification: 'local-credential' | 'remote-generation';
  outcome: ProbeOutcome;
  checkedAt: string;
  latencyMs: number;
  cached: false;
}

function reserveProbe(rawEnv: NodeJS.ProcessEnv, provider: string): boolean {
  const directory = join(getDataDir(rawEnv), 'state');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'provider-probe-quota.sqlite');
  const db = new Database(path);
  try {
    chmodSync(path, 0o600);
    db.pragma('busy_timeout = 3000');
    db.exec('CREATE TABLE IF NOT EXISTS attempts (provider TEXT NOT NULL, at INTEGER NOT NULL)');
    return db.transaction(() => {
      const now = Date.now();
      db.prepare('DELETE FROM attempts WHERE at <= ?').run(now - 15 * 60_000);
      const row = db.prepare('SELECT count(*) AS count FROM attempts WHERE provider = ?').get(provider) as { count: number };
      if (row.count >= 10) return false;
      db.prepare('INSERT INTO attempts VALUES (?, ?)').run(provider, now);
      return true;
    }).immediate();
  } finally { db.close(); }
}

/** Fixed output contract; no key shape, plaintext hash, provider body or exception text. */
export async function probeProvider(
  provider: string,
  options: { remote?: boolean; signal?: AbortSignal } = {},
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<ProviderProbeResult> {
  const started = performance.now();
  const verification = options.remote ? 'remote-generation' : 'local-credential';
  const finish = (outcome: ProbeOutcome): ProviderProbeResult => {
    const result: ProviderProbeResult = { provider, verification, outcome, checkedAt: new Date().toISOString(), latencyMs: Math.round(performance.now() - started), cached: false };
    // The audit row is its own fixed projection rather than the result
    // object. It carries the fields ARCHITECTURE.md asks a credential event
    // to record — what ran, what level, what happened, how long — and cannot
    // grow a field just because the caller-facing DTO does.
    writeSecurityAudit({
      action: 'provider.probe',
      status: ['usable', 'generated'].includes(outcome) ? 'allowed' : 'blocked',
      details: {
        provider: result.provider,
        verification: result.verification,
        outcome: result.outcome,
        latencyMs: result.latencyMs,
      },
    });
    return result;
  };
  if (!['minimax', 'anthropic', 'deepseek', 'glm'].includes(provider)) return finish('unsupported');
  if (options.signal?.aborted) return finish('cancelled');
  const credential = resolveProviderKeyResult(provider, rawEnv);if (credential.source === 'none') return finish(credential.reason === 'vault_error' ? 'credential-error' : 'not-configured');
  if (credential.source === 'conflict') return finish('credential-error');
  if (!options.remote) return finish('usable');
  // Other connectors are deliberately not advertised as cancellation-safe yet.
  if (provider !== 'minimax') return finish('unsupported');
  let destination: URL;
  try { destination = new URL(rawEnv.MINIMAX_BASE_URL || 'https://api.minimax.io/v1'); }
  catch { return finish('destination-denied'); }
  if (destination.protocol !== 'https:' || destination.username || destination.password || destination.search || destination.hash) return finish('destination-denied');
  try { if (!reserveProbe(rawEnv, provider)) return finish('rate-limited'); }
  catch { return finish('provider-error'); }
  const deadline = AbortSignal.timeout(15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  writeSecurityAudit({ action: 'provider.probe.started', status: 'allowed', details: { provider, verification } });
  try {
    const client = new MinimaxProvider({ apiKey: credential.key, model: rawEnv.MINIMAX_MODEL, baseUrl: destination.href.replace(/\/$/, '') });
    const reply = await client.chat([{ role: 'user', content: 'Reply with exactly MEMPHIS_OK.' }], { maxTokens: 32, temperature: 0, signal, rejectRedirects: true });
    return finish(reply.content.trim() ? 'generated' : 'invalid-response');
  } catch (error) {
    if (options.signal?.aborted) return finish('cancelled');
    if (deadline.aborted) return finish('timeout');
    if (error instanceof ProviderHttpError) {
      const outcomes: Record<number, ProbeOutcome> = { 400: 'bad-request', 401: 'unauthorized', 403: 'forbidden', 404: 'model-or-endpoint-not-found', 429: 'rate-limited' };
      return finish(outcomes[error.status] ?? 'provider-error');
    }
    return finish('network-error');
  }
}