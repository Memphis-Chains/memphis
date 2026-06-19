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
import { buildToolSchemaAuditReport } from '../../../gateway/tool-schema-audit.js';
import { buildToolSurfaceAuditReport } from '../../../gateway/tool-surface-audit.js';
import { inspectFirstRunStatus } from '../../../onboarding/first-run.js';
import { resolveProviderKeyResult } from '../../../providers/index.js';
import { probeVaultCipherCycle } from '../../../security/vault-boundary.js';
import { resolveVaultSecret } from '../../config/vault-resolve.js';
import { resolveInstallRoot } from '../../runtime/install-root.js';
import { assessRustBridgeManifestStatus } from '../../storage/rust-bridge-manifest.js';
import { getRustEmbedAdapterStatus } from '../../storage/rust-embed-adapter.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

function resolveEnvPath(env: NodeJS.ProcessEnv): string {
  if (env.MEMPHIS_ENV_FILE) return resolve(env.MEMPHIS_ENV_FILE);
  try {
    return resolve(resolveInstallRoot({ rawEnv: env }), '.env');
  } catch {
    return resolve('.env');
  }
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
  const status = assessRustBridgeManifestStatus(env);
  if (status.ok) {
    return row('rust_bridge', 'Rust bridge', 'ok', status.message);
  }
  return row(
    'rust_bridge',
    'Rust bridge',
    status.level === 'fail' && status.strictRequired ? 'fail' : 'warn',
    `${status.message} — run npm run build:rust`,
    status.strictRequired,
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

async function checkCapabilities(env: NodeJS.ProcessEnv): Promise<ReadinessRow> {
  try {
    const surface = buildToolSurfaceAuditReport(env);
    const schema = buildToolSchemaAuditReport(env);
    if (surface.ok && schema.ok) {
      return row(
        'capabilities',
        'Capabilities',
        'ok',
        `${surface.registryCount} tools; registry/executor/MCP/schema parity OK`,
      );
    }

    const issues: string[] = [];
    for (const item of surface.surfaces) {
      if (item.missingFromRegistry.length > 0) {
        issues.push(
          `${item.surface} has unregistered tools: ${item.missingFromRegistry.join(', ')}`,
        );
      }
      if (item.missingFromSurface.length > 0) {
        issues.push(`${item.surface} missing tools: ${item.missingFromSurface.join(', ')}`);
      }
    }
    if (schema.mismatches.length > 0) {
      issues.push(`${schema.mismatches.length} schema key mismatch(es)`);
    }
    if (schema.requiredMismatches.length > 0) {
      issues.push(`${schema.requiredMismatches.length} required-key mismatch(es)`);
    }
    if (schema.typeMismatches.length > 0) {
      issues.push(`${schema.typeMismatches.length} type mismatch(es)`);
    }
    if (schema.constraintMismatches.length > 0) {
      issues.push(`${schema.constraintMismatches.length} constraint mismatch(es)`);
    }
    if (schema.missingRegistrySchema.length > 0) {
      issues.push(`missing registry schema: ${schema.missingRegistrySchema.join(', ')}`);
    }
    if (schema.missingExecutorSchema.length > 0) {
      issues.push(`missing executor schema: ${schema.missingExecutorSchema.join(', ')}`);
    }
    if (schema.missingMcpSchema.length > 0) {
      issues.push(`missing MCP schema: ${schema.missingMcpSchema.join(', ')}`);
    }

    return row(
      'capabilities',
      'Capabilities',
      'fail',
      issues.slice(0, 4).join('; ') || 'tool surface parity failed',
    );
  } catch (error) {
    return row(
      'capabilities',
      'Capabilities',
      'fail',
      `unable to audit capabilities: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function checkDefaultProvider(env: NodeJS.ProcessEnv): Promise<ReadinessRow> {
  const provider = env.DEFAULT_PROVIDER ?? 'ollama';

  // No-key providers: local-fallback is built in, ollama runs over HTTP
  // without a key and has its own reachability check below.
  if (provider === 'local-fallback') {
    return row('default_provider', 'Default provider', 'info', 'local-fallback (no key required)');
  }
  if (provider === 'ollama') {
    const url = env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
    return row('default_provider', 'Default provider', 'info', `ollama → ${url} (no key required)`);
  }

  // OpenAI-compatible remote endpoints configured via *_API_BASE +
  // *_API_KEY. `VAULT:<entry>` is the on-disk form the CLI writes —
  // the readiness command runs BEFORE `resolveVaultSecrets`, so we do
  // the vault lookup ourselves via `resolveVaultSecret` and fail only
  // when the referenced entry is missing or unreadable. Plaintext
  // values are trusted as-is (the runtime's HTTP call is the real
  // validator). See Codex trail on PRs #218 → #219 → #220 → #221.
  if (provider === 'shared-llm' || provider === 'decentralized-llm') {
    const baseVar = provider === 'shared-llm' ? 'SHARED_LLM_API_BASE' : 'DECENTRALIZED_LLM_API_BASE';
    const keyVar = provider === 'shared-llm' ? 'SHARED_LLM_API_KEY' : 'DECENTRALIZED_LLM_API_KEY';
    const base = env[baseVar]?.trim();
    const key = env[keyVar]?.trim();
    if (!base) {
      return row(
        'default_provider',
        'Default provider',
        'fail',
        `${provider} is the default but ${baseVar} is not set`,
      );
    }
    if (!key) {
      return row(
        'default_provider',
        'Default provider',
        'fail',
        `${provider} is the default but ${keyVar} is not set`,
      );
    }
    // `VAULT:<entry>` is the on-disk form written by `memphis vault add`
    // + provider setup — it is NOT a resolution failure on its own. The
    // readiness CLI runs before `resolveVaultSecrets`, so we do the vault
    // lookup ourselves and fail only when the referenced vault entry is
    // missing or unreadable. Do NOT print the resolved values in the ok
    // detail — Codex caught that `${baseResolved}` would leak decrypted
    // URLs (potentially with embedded creds) and plaintext key material
    // into terminal history / logs / monitoring.
    if (resolveVaultSecret(base, env) === undefined) {
      return row(
        'default_provider',
        'Default provider',
        'fail',
        `${baseVar} references a vault entry that does not exist or could not be read. Run memphis vault list + memphis doctor --deep.`,
      );
    }
    if (resolveVaultSecret(key, env) === undefined) {
      return row(
        'default_provider',
        'Default provider',
        'fail',
        `${keyVar} references a vault entry that does not exist or could not be read. Run memphis vault list + memphis doctor --deep.`,
      );
    }
    // Match the exact prefix `resolveVaultSecret` recognizes in
    // `src/infra/config/vault-resolve.ts` — case-sensitive `VAULT:`.
    // A mis-cased `vault:my_key` is a literal plaintext value that
    // happens to look vault-ish; labelling it `(vault-resolved)` would
    // lie to operators. (Codex P2 follow-up on #220.)
    const baseSource = base.startsWith('VAULT:') ? `${baseVar} (vault-resolved)` : baseVar;
    const keySource = key.startsWith('VAULT:') ? `${keyVar} (vault-resolved)` : keyVar;
    return row(
      'default_provider',
      'Default provider',
      'ok',
      `${provider} → ${baseSource} + ${keySource}`,
    );
  }

  // Vault-keyed providers: anthropic, minimax, deepseek, glm. Actually call
  // the resolver to verify the vault entry is readable — previously we only
  // checked that *_VAULT_KEY was non-empty, which returned "ok" even when
  // the vault entry itself was missing or broken. (Codex B2 + B3.)
  const resolution = resolveProviderKeyResult(provider, env);
  switch (resolution.source) {
    case 'vault':
      return row(
        'default_provider',
        'Default provider',
        'ok',
        `${provider} → vault entry resolved`,
      );
    case 'plaintext':
      return row(
        'default_provider',
        'Default provider',
        'warn',
        `${provider} → plaintext key in env (consider moving to vault: memphis vault add --key ${provider}_api_key)`,
        false,
      );
    case 'conflict':
      return row(
        'default_provider',
        'Default provider',
        'fail',
        `${provider} has both a vault reference and a plaintext key, and the vault lookup failed: ${resolution.vaultError}. Resolve the conflict before restart.`,
      );
    case 'none':
      switch (resolution.reason) {
        case 'vault_not_configured':
          return row(
            'default_provider',
            'Default provider',
            'fail',
            `${provider} is the default but its vault mapping is not registered (provider unknown to runtime-registry)`,
          );
        case 'vault_not_found':
          return row(
            'default_provider',
            'Default provider',
            'fail',
            `${provider} has *_VAULT_KEY set but the vault entry is missing — run memphis vault add --key ${provider}_api_key`,
          );
        case 'vault_error':
          return row(
            'default_provider',
            'Default provider',
            'fail',
            `${provider} vault lookup errored (bridge down? corrupted entry?). Try memphis doctor --deep`,
          );
        case 'plaintext_not_configured':
          return row(
            'default_provider',
            'Default provider',
            'fail',
            `${provider} is the default but no *_VAULT_KEY or plaintext *_API_KEY is set`,
          );
      }
  }
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
    await checkCapabilities(env),
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
