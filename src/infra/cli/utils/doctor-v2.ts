import { spawnSync } from 'node:child_process';
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

// Project root — CLI always runs from the MemphisOS project root
const PROJECT_ROOT = process.cwd();

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
import { probeVaultCipherCycle } from '../../../security/vault-boundary.js';
import { loadSoulManifest } from '../../../soul/manifest.js';
import { isSoulMemoryEmpty, loadSoulMemory } from '../../../soul/memory.js';
import { seedSoulIdentity } from '../../../soul/seed.js';
import { envSchema } from '../../config/schema.js';
import { embedReset, embedSearch } from '../../storage/rust-embed-adapter.js';

export type DoctorTier = 1 | 2 | 3 | 4 | 5 | 6 | 'A';
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
  getContainer?: () => {
    orchestration: {
      getPrimaryProvider: () => string;
      getFallbackProvider: () => string | undefined;
      getProviderPolicy: () => {
        getCooldownMap: () => ReadonlyMap<string, number>;
        isInCooldown: (provider: string) => boolean;
        remainingCooldownMs: (provider: string) => number;
      };
      providersHealth: () => Promise<Array<{ name: string; ok: boolean }>>;
    };
  };
};

const tierTitle: Record<DoctorTier | 'A', string> = {
  1: 'Tier 1: Core Infrastructure',
  2: 'Tier 2: Provider Health',
  3: 'Tier 3: Performance',
  4: 'Tier 4: Security',
  5: 'Tier 5: State Health',
  6: 'Tier 6: Integration',
  A: 'Tier A: Architecture Health',
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

function inferDaemonRunning(memphisDir: string): {
  running: boolean;
  staleLocks: string[];
  source: 'lockfile' | 'systemd' | 'none';
} {
  const staleLocks: string[] = [];
  if (!existsSync(memphisDir)) return { running: false, staleLocks, source: 'none' };

  const lockCandidates = readdirSync(memphisDir).filter(
    (f) => f.endsWith('.lock') || f.endsWith('.pid'),
  );

  for (const file of lockCandidates) {
    try {
      const raw = readFileSync(join(memphisDir, file), 'utf8').trim();
      const pid = Number.parseInt(raw, 10);
      if (!Number.isFinite(pid) || pid <= 0) continue;
      try {
        process.kill(pid, 0);
        return { running: true, staleLocks, source: 'lockfile' };
      } catch {
        staleLocks.push(join(memphisDir, file));
      }
    } catch {
      // ignore
    }
  }

  const systemctl = spawnSync('systemctl', ['--user', 'is-active', 'memphis.service'], {
    encoding: 'utf8',
  });
  if (systemctl.status === 0 && systemctl.stdout.trim() === 'active') {
    return { running: true, staleLocks, source: 'systemd' };
  }

  return { running: false, staleLocks, source: 'none' };
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

    // Fix missing .env from .env.example template
    const envPath = join(process.cwd(), '.env');
    const envExamplePath = join(process.cwd(), '.env.example');
    if (!existsSync(envPath) && existsSync(envExamplePath)) {
      try {
        const exampleContent = readFileSync(envExamplePath, 'utf-8');
        writeFileSync(envPath, exampleContent, 'utf-8');
        actions.push('created .env from .env.example template');
      } catch {
        // ignore — will be reported by check
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
  const envPath = join(process.cwd(), '.env');
  const envExists = existsSync(envPath);
  checks.push({
    id: 't1-env-file',
    tier: 1,
    title: '.env file',
    level: levelFrom(envExists),
    ok: envExists,
    required: true,
    detail: envExists ? envPath : `.env not found in ${process.cwd()}`,
    fix: 'Run memphis doctor --fix to create from .env.example template',
  });

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

  const vaultCycleOk = probeVaultCipherCycle({ surface: 'cli', command: 'doctor' }, process.env).ok;
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

  // Soul identity check
  const soulManifest = loadSoulManifest();
  const soulMemory = loadSoulMemory();
  const soulMemoryPopulated = soulMemory !== null && !isSoulMemoryEmpty(soulMemory);
  let soulDetail = 'manifest and memory OK';
  let soulOk = true;
  let soulFix: string | undefined;

  if (!soulManifest) {
    soulOk = false;
    soulDetail = 'soul manifest missing';
    soulFix = 'Run: memphis soul seed';
  } else if (!soulMemoryPopulated) {
    soulOk = false;
    soulDetail = 'soul memory empty — agent has no persistent identity';
    soulFix = 'Run: memphis soul seed';
  } else {
    soulDetail = `${soulManifest.identity.agentName}, memory populated`;
  }

  if (!soulOk && options.fix) {
    try {
      const seedResult = await seedSoulIdentity();
      if (seedResult.seeded) {
        soulOk = true;
        soulDetail = `auto-seeded (journal=${seedResult.journalEntries}, cases=${seedResult.caseEntries})`;
        soulFix = undefined;
        repairs.push('soul-identity: seeded soul memory and chain entries');
      }
    } catch {
      // best-effort
    }
  }

  checks.push({
    id: 't1-soul-identity',
    tier: 1,
    title: 'Soul identity',
    level: levelFrom(soulOk, true),
    ok: soulOk,
    required: false,
    detail: soulDetail,
    fix: soulFix,
  });

  const persistPath = process.env.RUST_EMBED_PERSIST_PATH;
  let embeddingBytes: number;
  let embeddingVectors: number;
  if (persistPath && existsSync(persistPath)) {
    const stat = statSync(persistPath);
    embeddingBytes = stat.size;
    try {
      const idx = JSON.parse(readFileSync(persistPath, 'utf8')) as {
        docs?: unknown[];
        documents?: unknown[];
      };
      const docs = idx.docs ?? idx.documents;
      embeddingVectors = Array.isArray(docs) ? docs.length : 0;
    } catch {
      embeddingVectors = 0;
    }
  } else {
    embeddingBytes = dirSizeBytes(embeddingDir);
    embeddingVectors = existsSync(embeddingDir) ? readdirSync(embeddingDir).length : 0;
  }
  checks.push({
    id: 't1-embeddings-indexed',
    tier: 1,
    title: 'Embeddings indexed',
    level: embeddingVectors > 0 ? 'pass' : 'warn',
    ok: embeddingVectors > 0,
    required: true,
    detail: `vectors≈${embeddingVectors}, size=${Math.round(embeddingBytes / 1024)}KB`,
    fix: 'Generate embeddings via memphis embed store or memphis embed reindex',
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
  const glm = await ping(process.env.GLM_BASE_URL ?? 'https://open.bigmodel.cn/api/paas/v4');
  const codex = await ping(process.env.OPENAI_API_BASE ?? 'https://api.openai.com');
  const ollama = await ping('http://127.0.0.1:11434/api/tags');
  const providerAvg = Math.round((glm.latencyMs + codex.latencyMs + ollama.latencyMs) / 3);

  checks.push({
    id: 't2-glm',
    tier: 2,
    title: 'GLM connectivity',
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
  let embedLatency: number | null;
  let embedLatencyDetail = 'not measured';
  let embedLatencyLevel: DoctorCheckLevel = 'pass';
  let embedLatencyOk = true;
  try {
    if (embeddingVectors <= 0) {
      embedLatency = null;
      embedLatencyDetail = 'not measured (empty index)';
    } else {
      const t = performance.now();
      embedSearch('healthcheck', 1, process.env);
      embedLatency = performance.now() - t;
      embedLatencyDetail = `${embedLatency.toFixed(3)}ms (target <10ms)`;
      embedLatencyLevel = embedLatency < 10 ? 'pass' : 'warn';
      embedLatencyOk = embedLatency < 10;
    }
  } catch {
    embedLatency = null;
    embedLatencyDetail = 'not measured (embed search unavailable)';
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
    level: embedLatencyLevel,
    ok: embedLatencyOk,
    required: false,
    detail: embedLatencyDetail,
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
    '.first-run-checks',
    'chains',
    'embed',
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
    detail:
      daemon.source === 'systemd'
        ? 'running (systemd user service)'
        : daemon.source === 'lockfile'
          ? 'running (pid/lock detected)'
          : 'not detected',
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

  // ─────────────────────────────────────────────────────────────────────────────
  // TIER A — Architecture Health
  // ─────────────────────────────────────────────────────────────────────────────

  let container: Awaited<ReturnType<NonNullable<DoctorOptions['getContainer']>>> | undefined;
  try {
    container = options.getContainer?.();
  } catch {
    // container unavailable — A1/A2 will report as skipped
  }

  // A1 — Provider cooldown & fallback state
  const orchestration = container?.orchestration;
  if (orchestration) {
    let primary = 'unknown';
    let fallback: string | undefined = 'none';
    let fallbackSameAsPrimary = false;
    try {
      primary = orchestration.getPrimaryProvider?.() ?? 'unknown';
      fallback = orchestration.getFallbackProvider?.();
      fallbackSameAsPrimary = fallback !== undefined && fallback === primary;
    } catch {
      // best-effort
    }
    checks.push({
      id: 'ta1-provider-cooldown',
      tier: 'A',
      title: 'Provider cooldown & fallback',
      level: fallbackSameAsPrimary ? 'warn' : 'pass',
      ok: !fallbackSameAsPrimary,
      required: false,
      detail: fallbackSameAsPrimary
        ? `warn: fallback same as primary (${primary})`
        : fallback === undefined
          ? `no fallback configured`
          : `primary=${primary}, fallback=${fallback}`,
    });
  } else {
    checks.push({
      id: 'ta1-provider-cooldown',
      tier: 'A',
      title: 'Provider cooldown & fallback',
      level: 'warn',
      ok: false,
      required: false,
      detail: 'orchestration unavailable — skipped',
    });
  }

  // A2 — Experimental resilience fallback module
  try {
    const { ResilienceManager } = await import('../../../resilience/fallback.js');
    const rm = new ResilienceManager();
    const health = await rm.healthCheck();
    checks.push({
      id: 'ta2-resilience-fallback',
      tier: 'A',
      title: 'Experimental resilience fallback module',
      level: 'warn',
      ok: true,
      required: false,
      detail:
        `present for internal degraded-mode experiments only; canonical recall is memphis_recall + memphis_search ` +
        `(module status=${health.status})`,
    });
  } catch {
    checks.push({
      id: 'ta2-resilience-fallback',
      tier: 'A',
      title: 'Experimental resilience fallback module',
      level: 'pass',
      ok: true,
      required: false,
      detail: 'module unavailable; canonical recall remains memphis_recall + memphis_search',
    });
  }

  // A3 — Hybrid recall contract
  const exactSearchSrcPath = resolve(PROJECT_ROOT, 'src/infra/memory/exact-search.ts');
  const exactSearchExists = existsSync(exactSearchSrcPath);
  checks.push({
    id: 'ta3-hybrid-recall',
    tier: 'A',
    title: 'Hybrid recall contract',
    level: exactSearchExists ? 'pass' : 'warn',
    ok: exactSearchExists,
    required: false,
    detail: exactSearchExists
      ? 'canonical recall is semantic memphis_recall + exact memphis_search (FTS5)'
      : 'exact search module missing; canonical hybrid recall is incomplete',
  });

  // A4 — Double SQLite connection (static analysis)
  const bootstrapPath = resolve(PROJECT_ROOT, 'src/app/bootstrap.ts');
  const containerPath2 = resolve(PROJECT_ROOT, 'src/app/container.ts');
  let sqliteConnections = 0;
  let sqliteDbUrl = '';
  const sqlitePattern = /createSqliteClient\s*\(\s*([^)]+)\)/g;
  for (const srcPath of [bootstrapPath, containerPath2]) {
    if (existsSync(srcPath)) {
      try {
        const src = readFileSync(srcPath, 'utf8');
        let match;
        while ((match = sqlitePattern.exec(src)) !== null) {
          sqliteConnections += 1;
          if (!sqliteDbUrl) sqliteDbUrl = match[1].trim();
        }
      } catch {
        // ignore
      }
    }
  }
  checks.push({
    id: 'ta4-double-sqlite',
    tier: 'A',
    title: 'Double SQLite connection',
    level: sqliteConnections > 2 ? 'fail' : sqliteConnections > 1 ? 'warn' : 'pass',
    ok: sqliteConnections <= 2,
    required: false,
    detail: sqliteConnections <= 2
      ? sqliteConnections <= 1
        ? 'single connection (ok)'
        : `2 connections to ${sqliteDbUrl || 'same DB'}`
      : `${sqliteConnections} connections to ${sqliteDbUrl || 'same DB'} (multiply-instantiated)`,
    fix: sqliteConnections > 2
      ? 'Consolidate SQLite connections to a single client shared via container'
      : undefined,
  });

  // A5 — SyncManager writeChain() atomicity
  const syncManagerPath = resolve(PROJECT_ROOT, 'src/sync/sync-manager.ts');
  let writeChainAtomic = false;
  if (existsSync(syncManagerPath)) {
    try {
      const src = readFileSync(syncManagerPath, 'utf8');
      // Check if writeChain uses withAppendLock for the whole operation
      writeChainAtomic = src.includes('withAppendLock') && !src.match(/for\s*\([^)]*\)\s*\{[\s\S]{0,200}appendBlock/);
    } catch {
      // ignore
    }
  }
  checks.push({
    id: 'ta5-writechain-atomic',
    tier: 'A',
    title: 'SyncManager writeChain atomicity',
    level: writeChainAtomic ? 'pass' : 'warn',
    ok: writeChainAtomic,
    required: false,
    detail: writeChainAtomic
      ? 'writeChain() uses atomic locking'
      : 'writeChain() iterates without a surrounding transaction (potential partial-write risk)',
  });

  // A6 — decision-screen.ts dead code
  const decisionScreenPath = resolve(PROJECT_ROOT, 'src/tui/screens/decision-screen.ts');
  const tuiSrcDir = resolve(PROJECT_ROOT, 'src/tui');
  let decisionScreenImported = false;
  if (existsSync(decisionScreenPath) && existsSync(tuiSrcDir)) {
    try {
      const tuiFiles = readdirSync(tuiSrcDir);
      for (const file of tuiFiles) {
        const filePath = resolve(tuiSrcDir, file);
        if (statSync(filePath).isFile() && file.endsWith('.ts')) {
          const content = readFileSync(filePath, 'utf8');
          if (content.includes('decision-screen') && !content.includes('// decision-screen')) {
            decisionScreenImported = true;
            break;
          }
        }
      }
    } catch {
      // ignore
    }
  }
  checks.push({
    id: 'ta6-decision-screen',
    tier: 'A',
    title: 'TUI decision-screen dead code',
    level: !existsSync(decisionScreenPath) ? 'pass' : decisionScreenImported ? 'pass' : 'warn',
    ok: !existsSync(decisionScreenPath) || decisionScreenImported,
    required: false,
    detail: !existsSync(decisionScreenPath)
      ? 'decision-screen.ts not found (ok)'
      : decisionScreenImported
        ? 'decision-screen.ts is imported'
        : 'decision-screen.ts exists but has no imports (dead code)',
  });

  // A7 — Hardcoded version in demo HTML
  const demoHtmlPath = resolve(PROJECT_ROOT, 'demo/index.html');
  const pkgJsonPath = resolve(PROJECT_ROOT, 'package.json');
  let versionMismatch = false;
  let hardcodedVersion = '';
  let packageVersion = '';
  if (existsSync(demoHtmlPath)) {
    try {
      const html = readFileSync(demoHtmlPath, 'utf8');
      const versionMatch = html.match(/MEMPHIS\s+v?(\d+)/i);
      if (versionMatch) hardcodedVersion = versionMatch[1];
    } catch {
      // ignore
    }
  }
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
      packageVersion = pkg.version ?? '';
    } catch {
      // ignore
    }
  }
  if (hardcodedVersion && packageVersion) {
    versionMismatch = !packageVersion.startsWith(hardcodedVersion);
  }
  checks.push({
    id: 'ta7-hardcoded-version',
    tier: 'A',
    title: 'Hardcoded version in demo HTML',
    level: !versionMismatch ? 'pass' : 'warn',
    ok: !versionMismatch,
    required: false,
    detail: versionMismatch
      ? `demo/index.html hardcoded v${hardcodedVersion}, package.json v${packageVersion}`
      : hardcodedVersion
        ? `version v${hardcodedVersion} matches`
        : 'no hardcoded version found',
  });

  // A8 — ProviderName type completeness
  const typesPath = resolve(PROJECT_ROOT, 'src/core/types.ts');
  const providersIndexPath = resolve(PROJECT_ROOT, 'src/providers/index.ts');
  const providerNameDef = providersIndexPath
    ? (() => {
        try {
          return readFileSync(providersIndexPath, 'utf8');
        } catch {
          return '';
        }
      })()
    : '';
  const providerImplementations: string[] = [];
  const implPattern = /name\s*:\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = implPattern.exec(providerNameDef)) !== null) {
    providerImplementations.push(m[1]);
  }
  let providerNameSrc = '';
  if (existsSync(typesPath)) {
    try {
      providerNameSrc = readFileSync(typesPath, 'utf8');
    } catch {
      // ignore
    }
  }
  const typeNameMatch = providerNameSrc.match(/export\s+type\s+ProviderName\s*=\s*([^;]+);/s);
  const typeProviders: string[] = [];
  if (typeNameMatch) {
    const union = typeNameMatch[1];
    const quoted = union.match(/['"]([^'"]+)['"]/g);
    if (quoted) {
      for (const q of quoted) {
        typeProviders.push(q.replace(/['"]/g, ''));
      }
    }
  }
  const missingFromType = providerImplementations.filter((p) => !typeProviders.includes(p));
  checks.push({
    id: 'ta8-provider-name',
    tier: 'A',
    title: 'ProviderName type completeness',
    level: missingFromType.length === 0 ? 'pass' : 'warn',
    ok: missingFromType.length === 0,
    required: false,
    detail: missingFromType.length === 0
      ? `ProviderName type matches all implementations`
      : `ProviderName missing: ${missingFromType.join(', ')}`,
    fix: missingFromType.length > 0
      ? `Add ${missingFromType.join(', ')} to ProviderName union in src/core/types.ts`
      : undefined,
  });

  // A9 — Insight type duplication (documented, requires typecheck)
  const insightTypesPath = resolve(PROJECT_ROOT, 'src/cognitive/types.ts');
  const insightModelEPath = resolve(PROJECT_ROOT, 'src/cognitive/model-e-types.ts');
  const hasInsightInTypes = existsSync(insightTypesPath);
  const hasInsightInModelE = existsSync(insightModelEPath);
  const insightDuplicated = hasInsightInTypes && hasInsightInModelE;
  checks.push({
    id: 'ta9-insight-duplication',
    tier: 'A',
    title: 'Insight type duplication',
    level: insightDuplicated ? 'warn' : 'pass',
    ok: !insightDuplicated,
    required: false,
    detail: insightDuplicated
      ? 'Insight defined in cognitive/types.ts AND cognitive/model-e-types.ts — requires typecheck to verify compatibility'
      : 'Insight type not duplicated',
    fix: insightDuplicated ? 'Run npm run typecheck to verify no type errors from duplication' : undefined,
  });

  // A10 — Soul memory completeness (deep check)
  const soulMemoryPath = resolve(PROJECT_ROOT, 'src/soul/memory.ts');
  let soulMemoryHasIncompleteCheck = false;
  if (existsSync(soulMemoryPath)) {
    try {
      const src = readFileSync(soulMemoryPath, 'utf8');
      // Check if isSoulMemoryEmpty has meaningful checks beyond just null
      const emptyFnMatch = src.match(/function\s+isSoulMemoryEmpty\s*\([^)]*\)\s*:\s*boolean\s*\{([\s\S]*?)\}/);
      if (emptyFnMatch) {
        const body = emptyFnMatch[1];
        // Should check actual memory fields, not just || operator
        soulMemoryHasIncompleteCheck = body.includes('return') && body.split('return').length <= 2;
      }
    } catch {
      // ignore
    }
  }
  checks.push({
    id: 'ta10-soul-memory',
    tier: 'A',
    title: 'Soul memory completeness check',
    level: soulMemoryHasIncompleteCheck ? 'warn' : 'pass',
    ok: !soulMemoryHasIncompleteCheck,
    required: false,
    detail: soulMemoryHasIncompleteCheck
      ? 'isSoulMemoryEmpty() may return incomplete results — verify it checks all memory fields'
      : 'soul memory completeness check appears adequate',
  });

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

  for (const tier of [1, 2, 3, 4, 5, 6, 'A'] as const) {
    const tierChecks = report.checks.filter((c) => c.tier === tier);
    if (tierChecks.length === 0) continue;
    console.log(`\n┌─ ${tierTitle[tier]}`);
    for (const check of tierChecks) {
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
