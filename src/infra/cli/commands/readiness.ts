/**
 * memphis readiness — unified at-a-glance runtime status.
 *
 * Aggregates the facts operators ask for right after onboarding:
 *   - is the .env loaded?
 *   - did the first-run record land?
 *   - is the vault cipher usable?
 *   - is the Rust bridge active?
 *   - is the embed pipeline live?
 *   - what default provider is pointed at, and is its vault key resolvable?
 *   - optional channel gateways (telegram, matrix)
 *   - current LOOP_LIMITS in force
 *
 * Returns structured JSON with `--json` and a terse human table otherwise.
 * Exits 0 when every critical row is OK, 1 when any critical row is FAIL,
 * 2 when there are only non-critical warnings.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { getTelegramReadinessStatus } from '../../../gateway/channels/telegram-readiness.js';
import { LOOP_LIMITS } from '../../../gateway/loop-limits.js';
import { inspectFirstRunStatus } from '../../../onboarding/first-run.js';
import { probeVaultCipherCycle } from '../../../security/vault-boundary.js';
import { getChainAdapterStatus } from '../../storage/chain-adapter.js';
import { getRustEmbedAdapterStatus } from '../../storage/rust-embed-adapter.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

function resolveEnvPath(env: NodeJS.ProcessEnv): string {
  return resolve(env.MEMPHIS_ENV_FILE ?? '.env');
}

export type ReadinessLevel = 'ok' | 'warn' | 'fail' | 'info' | 'skip';

export type ReadinessRow = {
  id: string;
  label: string;
  level: ReadinessLevel;
  detail: string;
  critical: boolean;
};

export type ReadinessReport = {
  ok: boolean;
  exitCode: 0 | 1 | 2;
  summary: {
    total: number;
    ok: number;
    warn: number;
    fail: number;
    info: number;
    skip: number;
  };
  loopLimits: typeof LOOP_LIMITS;
  rows: ReadinessRow[];
};

export type ReadinessDeps = {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

function row(
  id: string,
  label: string,
  level: ReadinessLevel,
  detail: string,
  critical = true,
): ReadinessRow {
  return { id, label, level, detail, critical };
}

async function checkEnvFile(env: NodeJS.ProcessEnv): Promise<ReadinessRow> {
  const envPath = resolveEnvPath(env);
  return existsSync(envPath)
    ? row('env_file', 'Env file', 'ok', envPath)
    : row('env_file', 'Env file', 'fail', `missing at ${envPath} — run memphis init`);
}

async function checkFirstRun(env: NodeJS.ProcessEnv): Promise<ReadinessRow> {
  const status = inspectFirstRunStatus(env);
  if (status.state === 'initialized-clean') {
    const mode = status.record?.mode ?? 'unknown';
    const when = status.record?.initializedAt?.slice(0, 19).replace('T', ' ') ?? '—';
    return row('first_run', 'First run', 'ok', `${mode} at ${when}`);
  }
  if (status.state === 'not-initialized') {
    return row('first_run', 'First run', 'fail', 'not initialized — run memphis init');
  }
  return row(
    'first_run',
    'First run',
    'warn',
    `${status.state} — ${status.recommendedAction}`,
  );
}

async function checkVault(env: NodeJS.ProcessEnv): Promise<ReadinessRow> {
  const probe = probeVaultCipherCycle({ surface: 'cli', command: 'readiness' }, env);
  return probe.ok
    ? row('vault', 'Vault cipher', 'ok', 'encrypt/decrypt probe passed')
    : row('vault', 'Vault cipher', 'fail', probe.error ?? 'probe failed');
}

async function checkRustBridge(env: NodeJS.ProcessEnv): Promise<ReadinessRow> {
  const chain = getChainAdapterStatus(env);
  return chain.rustBridgeLoaded
    ? row('rust_bridge', 'Rust bridge', 'ok', 'NAPI chain adapter loaded')
    : row(
        'rust_bridge',
        'Rust bridge',
        'warn',
        'falling back to TS chain adapter — run npm run build:rust',
        false,
      );
}

async function checkEmbedPipeline(env: NodeJS.ProcessEnv): Promise<ReadinessRow> {
  const status = getRustEmbedAdapterStatus(env);
  return status.embedApiAvailable
    ? row('rust_embed', 'Embed pipeline', 'ok', 'rust embed API available')
    : row(
        'rust_embed',
        'Embed pipeline',
        'warn',
        'embed API unavailable — semantic search degraded',
        false,
      );
}

async function checkDefaultProvider(env: NodeJS.ProcessEnv): Promise<ReadinessRow> {
  const provider = env.DEFAULT_PROVIDER ?? 'anthropic';
  const vaultKeyByProvider: Record<string, string | undefined> = {
    anthropic: env.ANTHROPIC_VAULT_KEY,
    minimax: env.MINIMAX_VAULT_KEY,
    deepseek: env.DEEPSEEK_VAULT_KEY,
    glm: env.GLM_VAULT_KEY,
    'local-fallback': 'n/a',
  };
  const resolved = vaultKeyByProvider[provider];
  if (provider === 'local-fallback') {
    return row('default_provider', 'Default provider', 'info', 'local-fallback (no key required)');
  }
  if (!resolved) {
    return row(
      'default_provider',
      'Default provider',
      'warn',
      `${provider} is the default but no *_VAULT_KEY env var points at a vault entry`,
      false,
    );
  }
  return row(
    'default_provider',
    'Default provider',
    'ok',
    `${provider} → vault(${resolved})`,
  );
}

async function checkTelegram(
  env: NodeJS.ProcessEnv,
  fetchImpl: typeof fetch,
): Promise<ReadinessRow> {
  const status = await getTelegramReadinessStatus(env, {
    fetchImpl,
    includeRemoteBotLookup: false,
  });
  if (!status.configured) {
    return row(
      'telegram',
      'Telegram channel',
      'skip',
      'no bot token configured — optional',
      false,
    );
  }
  if (!status.gatewayEnabled) {
    return row(
      'telegram',
      'Telegram channel',
      'warn',
      'token present but MEMPHIS_CHANNEL_GATEWAY_ENABLED=false',
      false,
    );
  }
  if (!status.allowlistEnabled) {
    return row(
      'telegram',
      'Telegram channel',
      'warn',
      'no allowlist — the bot will accept messages from everyone',
      false,
    );
  }
  return row(
    'telegram',
    'Telegram channel',
    'ok',
    `gateway up with ${status.allowlistCount} allowlisted id(s)`,
    false,
  );
}

function loopLimitsRow(): ReadinessRow {
  const detail = `max_steps=${LOOP_LIMITS.max_steps} max_tool_calls=${LOOP_LIMITS.max_tool_calls} max_wait_ms=${LOOP_LIMITS.max_wait_ms} max_errors=${LOOP_LIMITS.max_errors}`;
  return row('loop_limits', 'Loop limits', 'info', detail, false);
}

export async function buildReadinessReport(
  deps: ReadinessDeps = {},
): Promise<ReadinessReport> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;

  const rows: ReadinessRow[] = [
    await checkEnvFile(env),
    await checkFirstRun(env),
    await checkVault(env),
    await checkRustBridge(env),
    await checkEmbedPipeline(env),
    await checkDefaultProvider(env),
    await checkTelegram(env, fetchImpl),
    loopLimitsRow(),
  ];

  const summary = {
    total: rows.length,
    ok: rows.filter((r) => r.level === 'ok').length,
    warn: rows.filter((r) => r.level === 'warn').length,
    fail: rows.filter((r) => r.level === 'fail').length,
    info: rows.filter((r) => r.level === 'info').length,
    skip: rows.filter((r) => r.level === 'skip').length,
  };

  const criticalFail = rows.some((r) => r.critical && r.level === 'fail');
  const anyWarn = rows.some((r) => r.level === 'warn');
  const exitCode: 0 | 1 | 2 = criticalFail ? 1 : anyWarn ? 2 : 0;

  return {
    ok: exitCode === 0,
    exitCode,
    summary,
    loopLimits: LOOP_LIMITS,
    rows,
  };
}

function levelGlyph(level: ReadinessLevel): string {
  switch (level) {
    case 'ok':
      return '✓';
    case 'warn':
      return '!';
    case 'fail':
      return '✗';
    case 'info':
      return '·';
    case 'skip':
      return '-';
  }
}

function renderHumanReport(report: ReadinessReport): string {
  const lines: string[] = ['memphis readiness'];
  const labelWidth = Math.max(...report.rows.map((r) => r.label.length));
  for (const r of report.rows) {
    const glyph = levelGlyph(r.level);
    const label = r.label.padEnd(labelWidth);
    lines.push(`  ${glyph} ${label}  ${r.detail}`);
  }
  lines.push('');
  const { ok, warn, fail, skip, info, total } = report.summary;
  lines.push(
    `  ${ok} ok · ${warn} warn · ${fail} fail · ${info} info · ${skip} skipped (total ${total})`,
  );
  return lines.join('\n');
}

export async function handleReadinessCommand(context: CliContext): Promise<boolean> {
  const { command, json } = context.args;
  if (command !== 'readiness') return false;

  const report = await buildReadinessReport();

  if (json) {
    print(report, true);
  } else {
    console.log(renderHumanReport(report));
  }

  process.exitCode = report.exitCode;
  return true;
}
