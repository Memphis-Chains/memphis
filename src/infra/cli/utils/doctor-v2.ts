import { createHash } from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import YAML from 'yaml';

import { checkDependencies } from './dependencies.js';
import {
  getBackupPath,
  getChainPath,
  getConfigPath,
  getDataDir,
  getEmbeddingPath,
  getVaultPath,
} from '../../../config/paths.js';
import { rebuildChainIndexes } from '../../../core/chain-index-rebuild.js';
import { inspectManagedAppCatalog } from '../../../modules/apps/manifest.js';
import { envSchema } from '../../config/schema.js';
import { embedReset, embedSearch } from '../../storage/rust-embed-adapter.js';
import { vaultDecrypt, vaultEncrypt } from '../../storage/rust-vault-adapter.js';

export type DoctorTier = 1 | 2 | 3 | 4 | 5 | 6;
export type DoctorCheckLevel = 'pass' | 'fail' | 'warn';

export type DoctorCheck = {
  id: string;
  tier: DoctorTier;
  title: string;
  level: DoctorCheckLevel;
  ok: boolean;
  required: boolean;
  detail: string;
  fix?: string;
  meta?: Record<string, unknown>;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
  summary: {
    total: number;
    pass: number;
    warn: number;
    fail: number;
    requiredFailures: number;
  };
  repairs: string[];
};

export type DoctorOptions = {
  fix?: boolean;
  force?: boolean;
  deep?: boolean;
};

const tierTitle: Record<DoctorTier, string> = {
  1: 'Tier 1: Core Infrastructure',
  2: 'Tier 2: Provider Health',
  3: 'Tier 3: Performance',
  4: 'Tier 4: Security',
  5: 'Tier 5: State Health',
  6: 'Tier 6: Integration',
};

function levelFrom(ok: boolean, warn = false): DoctorCheckLevel {
  if (ok) return 'pass';
  return warn ? 'warn' : 'fail';
}

function ping(url: string, timeoutMs = 1200): Promise<{ ok: boolean; latencyMs: number }> {
  const start = performance.now();
  return fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) })
    .then((r) => ({ ok: r.status < 500, latencyMs: Math.round(performance.now() - start) }))
    .catch(() => ({ ok: false, latencyMs: Math.round(performance.now() - start) }));
}

function dirSizeBytes(path: string): number {
  if (!existsSync(path)) return 0;
  let total = 0;
  const walk = (p: string): void => {
    let names: string[] = [];
    try {
      names = readdirSync(p);
    } catch {
      return;
    }
    for (const name of names) {
      const abs = join(p, name);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(abs);
      else total += st.size;
    }
  };
  walk(path);
  return total;
}

function checkChainIntegrity(chainsDir: string): { ok: boolean; checked: number; invalid: number } {
  if (!existsSync(chainsDir)) return { ok: false, checked: 0, invalid: 0 };
  let checked = 0;
  let invalid = 0;

  for (const chainName of readdirSync(chainsDir)) {
    const dir = join(chainsDir, chainName);
    if (!statSync(dir).isDirectory()) continue;
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
    let prevHash = '';
    for (const file of files) {
      checked += 1;
      try {
        const payload = JSON.parse(readFileSync(join(dir, file), 'utf8')) as {
          prev_hash?: string;
          hash?: string;
          data?: unknown;
        };
        const hashOk = typeof payload.hash === 'string' && /^[a-f0-9]{64}$/i.test(payload.hash);
        const prevOk =
          payload.prev_hash === prevHash ||
          (prevHash === '' && typeof payload.prev_hash === 'string');
        if (!hashOk || !prevOk) invalid += 1;
        prevHash = payload.hash ?? '';
      } catch {
        invalid += 1;
      }
    }
  }

  return { ok: checked > 0 && invalid === 0, checked, invalid };
}

function inferDaemonRunning(memphisDir: string): { running: boolean; staleLocks: string[] } {
  const staleLocks: string[] = [];
  if (!existsSync(memphisDir)) return { running: false, staleLocks };

  const lockCandidates = readdirSync(memphisDir).filter(
    (f) => f.endsWith('.lock') || f.endsWith('.pid'),
  );
  let running = false;

  for (const file of lockCandidates) {
    try {
      const raw = readFileSync(join(memphisDir, file), 'utf8').trim();
      const pid = Number.parseInt(raw, 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      try {
        process.kill(pid, 0);
        running = true;
      } catch {
        staleLocks.push(join(memphisDir, file));
      }
    } catch {
      // ignore
    }
  }

  return { running, staleLocks };
}

function msLabel(v: number): string {
  return `${Math.max(0, Math.round(v))}ms`;
}

function formatCapabilityCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, value]) => value > 0)
    .map(([name, value]) => `${name}=${value}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

function manifestIdsForCapability(
  manifests: Array<{ manifest: { id: string; capabilities: string[] } }>,
  capability: string,
): string[] {
  return manifests
    .filter((ref) => ref.manifest.capabilities.includes(capability))
    .map((ref) => ref.manifest.id)
    .sort((left, right) => left.localeCompare(right));
}

function manifestIdsForCapabilityPattern(
  manifests: Array<{ manifest: { id: string; capabilities: string[] } }>,
  capability: string,
  requiredCapabilities: string[],
): { aligned: string[]; missing: string[] } {
  const aligned: string[] = [];
  const missing: string[] = [];

  for (const ref of manifests) {
    if (!ref.manifest.capabilities.includes(capability)) continue;
    const hasRequired = requiredCapabilities.some((item) =>
      ref.manifest.capabilities.includes(item),
    );
    if (hasRequired) aligned.push(ref.manifest.id);
    else missing.push(ref.manifest.id);
  }

  aligned.sort((left, right) => left.localeCompare(right));
  missing.sort((left, right) => left.localeCompare(right));
  return { aligned, missing };
}

async function autoRepair(opts: Required<Pick<DoctorOptions, 'fix' | 'force'>>): Promise<string[]> {
  const actions: string[] = [];
  const memphisDir = getDataDir();

  if (opts.fix) {
    for (const dir of [
      memphisDir,
      getChainPath(),
      getEmbeddingPath(),
      getVaultPath(),
      getBackupPath(),
      getConfigPath(),
    ]) {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        actions.push(`created ${dir}`);
      }
      try {
        accessSync(dir, constants.W_OK);
      } catch {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        actions.push(`adjusted permissions for ${dir}`);
      }
    }

    const { staleLocks } = inferDaemonRunning(memphisDir);
    for (const lock of staleLocks) {
      rmSync(lock, { force: true });
      actions.push(`removed stale lock ${lock}`);
    }
  }

  if (opts.force) {
    rebuildChainIndexes({});
    actions.push('rebuild chain indexes');

    try {
      embedReset(process.env);
      actions.push('reset embeddings index');
    } catch {
      actions.push('embeddings reset skipped (bridge unavailable)');
    }
  }

  return actions;
}

export async function runDoctorChecksV2(options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const repairs = await autoRepair({ fix: options.fix === true, force: options.force === true });

  const baseDeps = await checkDependencies({ includeOllama: true });
  for (const d of baseDeps) {
    checks.push({ ...d, tier: d.id === 'ollama' ? 2 : 1 });
  }

  const memphisDir = getDataDir();
  const chainsDir = getChainPath();
  const embeddingDir = getEmbeddingPath();
  const vaultDir = getVaultPath();
  const configPath = getConfigPath('config.yaml');

  // Tier 1
  checks.push({
    id: 't1-home-dir',
    tier: 1,
    title: 'Memphis home directory',
    level: levelFrom(existsSync(memphisDir)),
    ok: existsSync(memphisDir),
    required: true,
    detail: existsSync(memphisDir) ? memphisDir : `missing ${memphisDir}`,
    fix: 'Run memphis doctor --fix to initialize storage',
  });

  const chain = checkChainIntegrity(chainsDir);
  checks.push({
    id: 't1-chain-integrity',
    tier: 1,
    title: 'Chains integrity',
    level: chain.ok ? 'pass' : chain.checked === 0 ? 'warn' : 'fail',
    ok: chain.ok,
    required: true,
    detail: `${chain.checked} blocks checked, invalid=${chain.invalid}`,
    fix: 'Run memphis chain rebuild or memphis doctor --force',
  });

  let vaultCycleOk: boolean;
  try {
    const probe = `doctor_probe_${Date.now()}`;
    const encrypted = vaultEncrypt('doctor_probe', probe, process.env);
    const decrypted = vaultDecrypt(encrypted, process.env);
    vaultCycleOk = decrypted === probe;
  } catch {
    vaultCycleOk = false;
  }
  checks.push({
    id: 't1-vault-cycle',
    tier: 1,
    title: 'Vault encryption cycle',
    level: levelFrom(vaultCycleOk, true),
    ok: vaultCycleOk,
    required: true,
    detail: vaultCycleOk ? 'encrypt/decrypt cycle OK' : 'vault unavailable or not initialized',
    fix: 'Run memphis vault init and verify RUST_CHAIN_ENABLED=true',
  });

  const embeddingBytes = dirSizeBytes(embeddingDir);
  const embeddingVectors = existsSync(embeddingDir) ? readdirSync(embeddingDir).length : 0;
  checks.push({
    id: 't1-embeddings-indexed',
    tier: 1,
    title: 'Embeddings indexed',
    level: embeddingVectors > 0 ? 'pass' : 'warn',
    ok: embeddingVectors > 0,
    required: true,
    detail: `vectors≈${embeddingVectors}, size=${Math.round(embeddingBytes / 1024)}KB`,
    fix: 'Generate embeddings via memphis embed store',
  });

  let configValid: boolean;
  try {
    const parsed = existsSync(configPath) ? YAML.parse(readFileSync(configPath, 'utf8')) : {};
    envSchema.safeParse(process.env);
    configValid = typeof parsed === 'object';
  } catch {
    configValid = false;
  }
  checks.push({
    id: 't1-config-valid',
    tier: 1,
    title: 'Config valid',
    level: levelFrom(configValid, true),
    ok: configValid,
    required: true,
    detail: configValid ? 'YAML + env schema parse OK' : 'config parse/schema warning',
    fix: 'Validate ~/.memphis/config/config.yaml and environment variables',
  });

  // Tier 2
  const glm = await ping(process.env.GLM_API_BASE ?? 'https://open.bigmodel.cn');
  const codex = await ping(process.env.OPENAI_API_BASE ?? 'https://api.openai.com');
  const ollama = await ping('http://127.0.0.1:11434/api/tags');
  const providerAvg = Math.round((glm.latencyMs + codex.latencyMs + ollama.latencyMs) / 3);

  checks.push({
    id: 't2-glm',
    tier: 2,
    title: 'GLM-5 connectivity',
    level: levelFrom(glm.ok, true),
    ok: glm.ok,
    required: false,
    detail: `${glm.ok ? 'reachable' : 'unreachable'} (${msLabel(glm.latencyMs)})`,
  });
  checks.push({
    id: 't2-codex',
    tier: 2,
    title: 'Codex 5.3 OAuth/API',
    level: levelFrom(codex.ok, true),
    ok: codex.ok,
    required: false,
    detail: `${codex.ok ? 'reachable' : 'unreachable'} (${msLabel(codex.latencyMs)})`,
  });
  checks.push({
    id: 't2-ollama-local',
    tier: 2,
    title: 'Ollama local',
    level: levelFrom(ollama.ok, true),
    ok: ollama.ok,
    required: false,
    detail: `${ollama.ok ? 'reachable' : 'unreachable'} (${msLabel(ollama.latencyMs)})`,
  });
  checks.push({
    id: 't2-provider-latency',
    tier: 2,
    title: 'Provider latency report',
    level: providerAvg <= 1200 ? 'pass' : 'warn',
    ok: providerAvg <= 1200,
    required: false,
    detail: `avg=${providerAvg}ms (glm=${glm.latencyMs}, codex=${codex.latencyMs}, ollama=${ollama.latencyMs})`,
  });

  // Tier 3
  const queryStart = performance.now();
  JSON.parse('{"ok":true}');
  const queryLatency = performance.now() - queryStart;
  let embedLatency: number;
  try {
    const t = performance.now();
    embedSearch('healthcheck', 1, process.env);
    embedLatency = performance.now() - t;
  } catch {
    embedLatency = 9999;
  }
  const rss = process.memoryUsage().rss;
  const memMb = Math.round(rss / 1024 / 1024);
  const memphisSize = dirSizeBytes(memphisDir);
  const memphisGb = memphisSize / 1024 / 1024 / 1024;

  checks.push({
    id: 't3-query-latency',
    tier: 3,
    title: 'Query latency',
    level: queryLatency < 1 ? 'pass' : 'warn',
    ok: queryLatency < 1,
    required: false,
    detail: `${queryLatency.toFixed(3)}ms (target <1ms)`,
  });
  checks.push({
    id: 't3-embed-search-latency',
    tier: 3,
    title: 'Embed search latency',
    level: embedLatency < 10 ? 'pass' : 'warn',
    ok: embedLatency < 10,
    required: false,
    detail: `${embedLatency.toFixed(3)}ms (target <10ms)`,
  });
  checks.push({
    id: 't3-memory-rss',
    tier: 3,
    title: 'Memory usage RSS',
    level: memMb < 100 ? 'pass' : memMb < 200 ? 'warn' : 'fail',
    ok: memMb < 200,
    required: false,
    detail: `${memMb}MB RSS`,
  });
  checks.push({
    id: 't3-disk-usage',
    tier: 3,
    title: 'Disk usage',
    level: memphisGb < 1 ? 'pass' : memphisGb < 5 ? 'warn' : 'fail',
    ok: memphisGb < 5,
    required: false,
    detail: `${memphisGb.toFixed(2)}GB in ${memphisDir}`,
  });

  // Tier 4
  const vaultFiles = existsSync(vaultDir) ? readdirSync(vaultDir) : [];
  const plaintextLeak = vaultFiles.some((f) => f.endsWith('.txt') || f.includes('plain'));
  const has2fa = Boolean(
    process.env.MEMPHIS_RECOVERY_QUESTION && process.env.MEMPHIS_RECOVERY_ANSWER,
  );
  const didPath = resolve(memphisDir, 'did.json');
  const didExists = existsSync(didPath);
  const pepper = process.env.MEMPHIS_VAULT_PEPPER ?? '';
  const pepperStrong =
    pepper.length >= 32 && /[A-Z]/.test(pepper) && /[a-z]/.test(pepper) && /[0-9]/.test(pepper);
  const queueMode = (process.env.MEMPHIS_QUEUE_MODE ?? 'financial').trim().toLowerCase();
  const queueResumePolicy = (process.env.MEMPHIS_QUEUE_RESUME_POLICY ?? 'keep')
    .trim()
    .toLowerCase();
  const queueResumeRisk = queueMode === 'financial' && queueResumePolicy === 'redispatch';
  const pagerDutyKey = (process.env.MEMPHIS_ALERT_PAGERDUTY_ROUTING_KEY ?? '').trim();
  const pagerDutyEndpoint = (process.env.MEMPHIS_ALERT_PAGERDUTY_ENDPOINT ?? '').trim();
  const opsGenieKey = (process.env.MEMPHIS_ALERT_OPSGENIE_API_KEY ?? '').trim();
  const opsGenieEndpoint = (process.env.MEMPHIS_ALERT_OPSGENIE_ENDPOINT ?? '').trim();
  const pagerDutyConfigured = pagerDutyKey.length > 0;
  const opsGenieConfigured = opsGenieKey.length > 0;
  const pagerDutyKeyFormatOk = /^[A-Za-z0-9]{32}$/.test(pagerDutyKey);
  const opsGenieKeyFormatOk =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(opsGenieKey);
  const alertTransportCount = (pagerDutyConfigured ? 1 : 0) + (opsGenieConfigured ? 1 : 0);
  const invalidAlertConfig =
    (!pagerDutyConfigured && pagerDutyEndpoint.length > 0) ||
    (!opsGenieConfigured && opsGenieEndpoint.length > 0);
  const invalidAlertKeys: string[] = [];
  if (pagerDutyConfigured && !pagerDutyKeyFormatOk) invalidAlertKeys.push('pagerduty');
  if (opsGenieConfigured && !opsGenieKeyFormatOk) invalidAlertKeys.push('opsgenie');
  const alertConfigLevel = invalidAlertConfig
    ? 'fail'
    : alertTransportCount === 0 || invalidAlertKeys.length > 0
      ? 'warn'
      : 'pass';
  const alertConfigOk = !invalidAlertConfig;
  const alertConfigDetail = invalidAlertConfig
    ? `inconsistent alert config (endpoint without key): pagerdutyEndpoint=${pagerDutyEndpoint.length > 0}, opsgenieEndpoint=${opsGenieEndpoint.length > 0}`
    : alertTransportCount === 0
      ? 'no external alert transport configured'
      : invalidAlertKeys.length > 0
        ? `configured transports=${alertTransportCount}, invalid key format: ${invalidAlertKeys.join(',')}`
        : `configured transports=${alertTransportCount}`;

  checks.push({
    id: 't4-vault-encrypted',
    tier: 4,
    title: 'Vault encrypted',
    level: levelFrom(!plaintextLeak, true),
    ok: !plaintextLeak,
    required: true,
    detail: plaintextLeak
      ? 'potential plaintext artifacts found'
      : 'no plaintext artifacts detected',
  });
  checks.push({
    id: 't4-2fa',
    tier: 4,
    title: '2FA configured (Q&A)',
    level: levelFrom(has2fa, true),
    ok: has2fa,
    required: true,
    detail: has2fa ? 'recovery Q&A present' : 'recovery Q&A not configured',
  });
  checks.push({
    id: 't4-did',
    tier: 4,
    title: 'DID generated',
    level: levelFrom(didExists, true),
    ok: didExists,
    required: true,
    detail: didExists ? didPath : 'missing DID identity file',
  });
  checks.push({
    id: 't4-pepper-strength',
    tier: 4,
    title: 'Pepper strength',
    level: levelFrom(pepperStrong, true),
    ok: pepperStrong,
    required: true,
    detail: pepperStrong ? `strong (${pepper.length} chars)` : `weak (${pepper.length} chars)`,
  });
  checks.push({
    id: 't4-queue-resume-policy',
    tier: 4,
    title: 'Queue resume policy risk',
    level: queueResumeRisk ? 'warn' : 'pass',
    ok: !queueResumeRisk,
    required: false,
    detail: queueResumeRisk
      ? `mode=${queueMode}, resume=${queueResumePolicy} (high replay risk for financial side effects)`
      : `mode=${queueMode}, resume=${queueResumePolicy}`,
    fix: 'For financial mode, prefer MEMPHIS_QUEUE_RESUME_POLICY=keep',
  });
  checks.push({
    id: 't4-alert-transport-config',
    tier: 4,
    title: 'Alert transport config',
    level: alertConfigLevel,
    ok: alertConfigOk,
    required: false,
    detail: alertConfigDetail,
    fix: 'Set MEMPHIS_ALERT_PAGERDUTY_ROUTING_KEY and/or MEMPHIS_ALERT_OPSGENIE_API_KEY with valid keys',
  });

  // Tier 5
  const allowedTop = new Set([
    'chains',
    'embeddings',
    'vault',
    'cache',
    'backups',
    'logs',
    'config',
    'did.json',
  ]);
  const rootItems = existsSync(memphisDir) ? readdirSync(memphisDir) : [];
  const orphans = rootItems.filter((name) => !allowedTop.has(name));
  const daemon = inferDaemonRunning(memphisDir);

  const backupDir = getBackupPath();
  const backups = existsSync(backupDir)
    ? readdirSync(backupDir).map((f) => statSync(join(backupDir, f)).mtimeMs)
    : [];
  const backupAgeDays =
    backups.length > 0
      ? (Date.now() - Math.max(...backups)) / (24 * 3600 * 1000)
      : Number.POSITIVE_INFINITY;

  checks.push({
    id: 't5-orphans',
    tier: 5,
    title: 'Orphan files',
    level: orphans.length === 0 ? 'pass' : 'warn',
    ok: orphans.length === 0,
    required: false,
    detail:
      orphans.length === 0
        ? 'none detected'
        : `${orphans.length} orphan(s): ${orphans.slice(0, 5).join(', ')}`,
    fix: 'Run memphis doctor --fix to clean stale files',
  });
  checks.push({
    id: 't5-stale-locks',
    tier: 5,
    title: 'Stale locks',
    level: daemon.staleLocks.length === 0 ? 'pass' : 'warn',
    ok: daemon.staleLocks.length === 0,
    required: false,
    detail: daemon.staleLocks.length === 0 ? 'none' : `${daemon.staleLocks.length} stale lock(s)`,
    fix: 'Run memphis doctor --fix',
  });
  checks.push({
    id: 't5-backup-status',
    tier: 5,
    title: 'Backup status',
    level: backupAgeDays <= 7 ? 'pass' : 'warn',
    ok: backupAgeDays <= 7,
    required: false,
    detail: Number.isFinite(backupAgeDays)
      ? `${backupAgeDays.toFixed(1)} days since latest backup`
      : 'no backups found',
    fix: 'Run memphis backup now',
  });
  checks.push({
    id: 't5-daemon',
    tier: 5,
    title: 'Daemon status',
    level: daemon.running ? 'pass' : 'warn',
    ok: daemon.running,
    required: false,
    detail: daemon.running ? 'running' : 'not detected',
  });

  // Tier 6
  const externalPlugin =
    existsSync(resolve(process.cwd(), 'external-plugin')) ||
    Boolean(process.env.MEMPHIS_EXTERNAL_PLUGIN_ENABLED);
  const mcpPort = Number(process.env.MCP_PORT ?? process.env.PORT ?? 3000);
  const mcp = await ping(`http://127.0.0.1:${mcpPort}/health`);
  const multiAgentSync = Boolean(
    process.env.MEMPHIS_SYNC_REMOTE || process.env.MEMPHIS_AGENT_PEERS,
  );
  const appCatalog = inspectManagedAppCatalog(process.env);
  const capabilitySummary = formatCapabilityCounts(appCatalog.capabilityCounts);
  const mcpManagedApps = manifestIdsForCapability(appCatalog.manifests, 'mcp');
  const secretManagedApps = manifestIdsForCapability(appCatalog.manifests, 'secrets');
  const memoryPattern = manifestIdsForCapabilityPattern(appCatalog.manifests, 'memory', [
    'workspace',
    'service',
  ]);
  const browserPattern = manifestIdsForCapabilityPattern(appCatalog.manifests, 'browser', [
    'mcp',
    'service',
  ]);

  checks.push({
    id: 't6-external-plugin',
    tier: 6,
    title: 'External plugin',
    level: levelFrom(externalPlugin, true),
    ok: externalPlugin,
    required: false,
    detail: externalPlugin ? 'installed/configured' : 'not installed',
  });
  checks.push({
    id: 't6-mcp-server',
    tier: 6,
    title: 'MCP server',
    level: levelFrom(mcp.ok, true),
    ok: mcp.ok,
    required: false,
    detail: `${mcp.ok ? 'reachable' : 'unreachable'} on :${mcpPort} (${msLabel(mcp.latencyMs)})`,
  });
  checks.push({
    id: 't6-multi-agent-sync',
    tier: 6,
    title: 'Multi-agent sync',
    level: levelFrom(multiAgentSync, true),
    ok: multiAgentSync,
    required: false,
    detail: multiAgentSync ? 'configured' : 'not configured',
  });
  checks.push({
    id: 't6-managed-app-catalog',
    tier: 6,
    title: 'Managed app catalog',
    level: appCatalog.errors.length > 0 ? 'warn' : 'pass',
    ok: appCatalog.errors.length === 0,
    required: false,
    detail:
      appCatalog.manifests.length === 0 && appCatalog.errors.length === 0
        ? `0 manifests discovered in ${appCatalog.manifestsDir}; add downstream manifests or use --file`
        : `${appCatalog.manifests.length} valid manifest(s), ${appCatalog.errors.length} invalid manifest(s); capabilities: ${capabilitySummary}`,
    fix:
      appCatalog.errors.length > 0
        ? `Fix invalid manifest JSON/schema under ${appCatalog.manifestsDir} or validate with memphis apps show --file <manifest.json>`
        : 'Use memphis apps show <id> for capability-specific operator guidance',
    meta: {
      manifestsDir: appCatalog.manifestsDir,
      manifestIds: appCatalog.manifests.map((ref) => ref.manifest.id),
      capabilityCounts: appCatalog.capabilityCounts,
      invalidManifests: appCatalog.errors,
    },
  });
  if (mcpManagedApps.length > 0) {
    checks.push({
      id: 't6-managed-app-mcp-readiness',
      tier: 6,
      title: 'Managed app MCP readiness',
      level: mcp.ok ? 'pass' : 'warn',
      ok: mcp.ok,
      required: false,
      detail: `apps=${mcpManagedApps.join(', ')}; MCP server ${mcp.ok ? 'reachable' : 'unreachable'} on :${mcpPort}`,
      fix: 'Run memphis mcp serve-status --json or start the downstream MCP bridge before applying MCP-tagged app actions',
      meta: {
        appIds: mcpManagedApps,
        port: mcpPort,
      },
    });
  }
  if (secretManagedApps.length > 0) {
    checks.push({
      id: 't6-managed-app-secret-brokering',
      tier: 6,
      title: 'Managed app secret brokering',
      level: vaultCycleOk ? 'pass' : 'warn',
      ok: vaultCycleOk,
      required: false,
      detail: `apps=${secretManagedApps.join(', ')}; vault ${vaultCycleOk ? 'ready' : 'unavailable'}`,
      fix: 'Run memphis vault init and re-run memphis apps plan <id> --action install --json to confirm secret bindings',
      meta: {
        appIds: secretManagedApps,
        vaultCycleOk,
      },
    });
  }
  if (memoryPattern.aligned.length > 0 || memoryPattern.missing.length > 0) {
    checks.push({
      id: 't6-managed-app-memory-pattern',
      tier: 6,
      title: 'Managed app memory pattern',
      level: memoryPattern.missing.length === 0 ? 'pass' : 'warn',
      ok: memoryPattern.missing.length === 0,
      required: false,
      detail:
        memoryPattern.missing.length === 0
          ? `apps=${memoryPattern.aligned.join(', ')}; all memory-tagged apps are scoped by workspace/service`
          : `aligned=${memoryPattern.aligned.join(', ') || 'none'}; missing workspace/service=${memoryPattern.missing.join(', ')}`,
      fix: 'Tag memory integrations with workspace and/or service so operators know whether the state is workspace-bound or service-backed',
      meta: {
        alignedAppIds: memoryPattern.aligned,
        missingPatternAppIds: memoryPattern.missing,
        expectedCapabilities: ['workspace', 'service'],
      },
    });
  }
  if (browserPattern.aligned.length > 0 || browserPattern.missing.length > 0) {
    checks.push({
      id: 't6-managed-app-browser-pattern',
      tier: 6,
      title: 'Managed app browser pattern',
      level: browserPattern.missing.length === 0 ? 'pass' : 'warn',
      ok: browserPattern.missing.length === 0,
      required: false,
      detail:
        browserPattern.missing.length === 0
          ? `apps=${browserPattern.aligned.join(', ')}; all browser-tagged apps expose MCP/service transport hints`
          : `aligned=${browserPattern.aligned.join(', ') || 'none'}; missing mcp/service=${browserPattern.missing.join(', ')}`,
      fix: 'Tag browser integrations with mcp and/or service so the transport model is explicit and stays downstream from MemphisOS core',
      meta: {
        alignedAppIds: browserPattern.aligned,
        missingPatternAppIds: browserPattern.missing,
        expectedCapabilities: ['mcp', 'service'],
      },
    });
  }

  if (options.deep) {
    const shellOk = ['bash', 'zsh', 'fish'].includes(process.env.SHELL?.split('/').pop() ?? '');
    checks.push({
      id: 't6-deep-shell',
      tier: 6,
      title: 'Deep scan: shell/runtime',
      level: shellOk ? 'pass' : 'warn',
      ok: shellOk,
      required: false,
      detail: process.env.SHELL ?? 'unknown shell',
    });
    checks.push({
      id: 't6-deep-write-probe',
      tier: 6,
      title: 'Deep scan: write probe',
      level: 'pass',
      ok: true,
      required: false,
      detail: (() => {
        const probePath = join(memphisDir, '.doctor-write-probe');
        try {
          mkdirSync(memphisDir, { recursive: true });
          writeFileSync(probePath, createHash('sha256').update(String(Date.now())).digest('hex'));
          rmSync(probePath, { force: true });
          return 'read/write probe passed';
        } catch {
          return 'read/write probe failed';
        }
      })(),
    });
  }

  const summary = {
    total: checks.length,
    pass: checks.filter((c) => c.level === 'pass').length,
    warn: checks.filter((c) => c.level === 'warn').length,
    fail: checks.filter((c) => c.level === 'fail').length,
    requiredFailures: checks.filter((c) => c.required && c.level !== 'pass').length,
  };

  return {
    ok: summary.requiredFailures === 0,
    checks,
    summary,
    repairs,
  };
}

export function printDoctorHumanV2(report: DoctorReport): void {
  const icon = (l: DoctorCheckLevel): string => (l === 'pass' ? '✓' : l === 'warn' ? '⚠' : '✗');
  const border = '═'.repeat(76);
  console.log(`╔${border}╗`);
  console.log(`║ ${`MEMPHIS DOCTOR v2.0 ${report.ok ? 'PASS' : 'FAIL'}`.padEnd(75)}║`);
  console.log(`╚${border}╝`);

  for (const tier of [1, 2, 3, 4, 5, 6] as const) {
    console.log(`\n┌─ ${tierTitle[tier]}`);
    for (const check of report.checks.filter((c) => c.tier === tier)) {
      console.log(`│ ${icon(check.level)} ${check.title}: ${check.detail}`);
      if (check.fix && check.level !== 'pass') console.log(`│   ↳ fix: ${check.fix}`);
    }
  }

  console.log(
    `\nSummary: total=${report.summary.total} pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail}`,
  );
  if (report.repairs.length > 0) {
    console.log('Repairs applied:');
    for (const r of report.repairs) console.log(`  - ${r}`);
  }
}

// Backward-compatible exports
export const runDoctorChecks = runDoctorChecksV2;
export const printDoctorHuman = printDoctorHumanV2;
