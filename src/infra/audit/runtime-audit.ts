/**
 * The runtime audit — one entry point that measures the LIVE system.
 *
 * `docs/design/MEMPHIS-HOLES-AND-REFACTOR.md` §3.1 (S0) is the spec.
 * The short version: the six gates that measure the wrong thing all
 * pass while the failure they name is live on this host. The audit
 * replaces "a gate that passes" with "a measurement of the real thing,
 * with a verdict".
 *
 * THE RULES OF THIS FILE
 *
 * 1. It measures the live system. Live chains, the live `.env`, the
 *    live build, the live repository, the live workflows. Fixtures are
 *    what the old gates scanned; that is the hole, not the method.
 * 2. It never writes. Every probe is read-only. The native probe is
 *    `chain_validate`, which parses a block and returns — it does not
 *    touch the disk (the Rust `chain_append` returns the new chain in
 *    its response instead of writing it, but the audit does not use it).
 * 3. A check that cannot reach what it measures says `unknown`, never
 *    `success`. That is the whole point: the difference between a
 *    measurement and a green light.
 * 4. The verdict comes from `src/infra/audit/checks.ts`, which is pure.
 *    This file gathers numbers; it does not decide.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  checkBlockVocabulary,
  checkBranchBoundary,
  checkChainRegistry,
  checkDeploymentFreshness,
  checkGateCoverage,
  checkHealthReporting,
  checkPostmortemStatus,
  checkSloReporting,
  type UnreadableBlock,
} from './checks.js';
import { worstVerdict, type AuditCheckResult, type RuntimeAuditReport } from './types.js';
import { getChainPath } from '../../config/paths.js';
import { runMemphisSloStatus } from '../../mcp/tools/slo-status.js';
import {
  getChainNames,
  getConditionalChainNames,
  getStandardChainNames,
  isChainBackupDirectory,
} from '../../memory/chain-catalog.js';
import { CLI_COMMAND_REGISTRY } from '../cli/registry.js';
import { loadConfig } from '../config/env.js';
import type { AppConfig } from '../config/schema.js';
import { buildHealthPayload } from '../http/health.js';
import { BlockVocabularyOracle } from '../storage/block-vocabulary.js';
import {
  deriveChainRegistry,
  getChainAllowlist,
  isScannableChainDirectoryName,
} from '../storage/chain-adapter.js';

const execFileAsync = promisify(execFile);

export interface RuntimeAuditOptions {
  readonly rawEnv?: NodeJS.ProcessEnv;
  readonly repoRoot?: string;
  /** The app config, for the health payload. Loaded when omitted. */
  readonly config?: AppConfig;
  readonly windowDays?: number;
  readonly now?: Date;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

async function git(args: readonly string[], cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function findRepoRoot(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    const [pkg, gitEntry] = await Promise.all([
      fs.stat(path.join(dir, 'package.json')).then(
        () => true,
        () => false,
      ),
      fs.stat(path.join(dir, '.git')).then(
        () => true,
        () => false,
      ),
    ]);
    if (pkg && gitEntry) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

async function newestMtime(dir: string): Promise<number | null> {
  let newest: number | null = null;
  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      const stat = await fs.stat(full).catch(() => null);
      if (stat && (newest === null || stat.mtimeMs > newest)) newest = stat.mtimeMs;
    }
  };
  await walk(dir, 0);
  return newest;
}

async function readTextIfExists(file: string): Promise<string | null> {
  return fs.readFile(file, 'utf8').catch(() => null);
}

/* ------------------------------------------------------------------ */
/* collectors                                                          */
/* ------------------------------------------------------------------ */

interface ChainRegistryFacts {
  catalogNames: string[];
  standardChainNames: string[];
  conditionalChainNames: string[];
  registryNames: string[];
  registryArchiveNames: string[];
  effectiveAllowlist: string[];
  configAllowlist: string[] | null;
  diskDirs: string[];
  scannableDirs: string[];
}

async function collectChainRegistry(
  rawEnv: NodeJS.ProcessEnv,
  repoRoot: string | null,
): Promise<ChainRegistryFacts> {
  const chainsDir = getChainPath(undefined, rawEnv);
  const entries = await fs.readdir(chainsDir, { withFileTypes: true }).catch(() => []);
  const diskDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

  let configAllowlist: string[] | null = null;
  if (repoRoot) {
    const envText = await readTextIfExists(path.join(repoRoot, '.env'));
    if (envText) {
      const line = envText
        .split('\n')
        .find((entry) => entry.trim().startsWith('MEMPHIS_CHAINS_ALLOWLIST='));
      if (line) {
        configAllowlist = line
          .slice(line.indexOf('=') + 1)
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
      }
    }
  }

  // The registry is the ONE list: what the taxonomy names and the disk
  // holds. The collector reads it from the code that owns it rather
  // than re-deriving it — a second derivation here is the drift the
  // audit exists to catch.
  const registry = deriveChainRegistry(rawEnv);
  const registryNames = [...registry];
  const registryArchiveNames = registryNames.filter((name) => isChainBackupDirectory(name));

  return {
    catalogNames: getChainNames(),
    standardChainNames: getStandardChainNames(),
    conditionalChainNames: getConditionalChainNames(),
    registryNames,
    registryArchiveNames,
    effectiveAllowlist: [...getChainAllowlist(rawEnv)],
    configAllowlist,
    diskDirs,
    scannableDirs: diskDirs.filter((name) => isScannableChainDirectoryName(name)),
  };
}

interface BlockVocabularyFacts {
  oracleAvailable: boolean;
  totalBlocks: number;
  unreadable: UnreadableBlock[];
  chainsScanned: number;
}

async function collectBlockVocabulary(
  rawEnv: NodeJS.ProcessEnv,
  effectiveAllowlist: readonly string[],
): Promise<BlockVocabularyFacts> {
  const chainsDir = getChainPath(undefined, rawEnv);
  // The oracle is the ONE way this codebase asks the native core whether
  // a block is readable. The audit uses the same implementation the repair
  // uses, so "the audit says unreadable" and "the repair fixed it" cannot
  // come to mean two different things.
  const oracle = new BlockVocabularyOracle(rawEnv);

  if (!oracle.available()) {
    return { oracleAvailable: false, totalBlocks: 0, unreadable: [], chainsScanned: 0 };
  }

  let totalBlocks = 0;
  let chainsScanned = 0;
  const unreadable: UnreadableBlock[] = [];

  for (const chain of effectiveAllowlist) {
    const dir = path.join(chainsDir, chain);
    const files = (await fs.readdir(dir).catch(() => [])).filter((name) => name.endsWith('.json'));
    if (files.length === 0) continue;
    chainsScanned += 1;

    for (const file of files.sort()) {
      const raw = await readTextIfExists(path.join(dir, file));
      if (raw === null) continue;
      let block: Record<string, unknown>;
      try {
        block = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        unreadable.push({
          chain,
          file,
          error: 'the file is not JSON',
        });
        continue;
      }
      totalBlocks += 1;
      const complaint = oracle.complaint(block as never);
      if (complaint === null) continue;
      const data = (block.data ?? {}) as Record<string, unknown>;
      unreadable.push({
        chain,
        file,
        type: typeof data.type === 'string' ? data.type : undefined,
        error: complaint,
      });
    }
  }

  return { oracleAvailable: true, totalBlocks, unreadable, chainsScanned };
}

async function collectSloReporting(
  rawEnv: NodeJS.ProcessEnv,
  windowDays: number,
): Promise<{ metrics: { name: string; status: string }[]; verdictPassing: boolean }> {
  try {
    const report = await runMemphisSloStatus({ windowDays }, rawEnv);
    return {
      metrics: report.slos.map((metric) => ({ name: metric.name, status: metric.status })),
      verdictPassing: report.allSlosPassing,
    };
  } catch {
    return { metrics: [], verdictPassing: false };
  }
}

async function collectHealthReporting(
  config: AppConfig | null,
  rawEnv: NodeJS.ProcessEnv,
): Promise<{ topLine: string; failing: string[] } | null> {
  if (!config) return null;
  try {
    const payload = await buildHealthPayload(config, rawEnv);
    const checks = (payload.checks ?? {}) as Record<
      string,
      { status?: string; message?: string } | undefined
    >;
    const failing = Object.entries(checks)
      .filter(([, check]) => check && check.status !== 'ok')
      .map(([name]) => name);
    return { topLine: payload.status ?? 'unknown', failing };
  } catch {
    return null;
  }
}

interface DeploymentFacts {
  commitsBehind: number | null;
  missingCommands: string[];
  distNewestIso: string | null;
  mainHead: string | null;
}

async function collectDeploymentFreshness(repoRoot: string | null): Promise<DeploymentFacts> {
  if (!repoRoot) {
    return {
      commitsBehind: null,
      missingCommands: [],
      distNewestIso: null,
      mainHead: null,
    };
  }

  const distDir = path.join(repoRoot, 'dist');
  const newest = await newestMtime(distDir);
  const distNewestIso = newest === null ? null : new Date(newest).toISOString();

  let commitsBehind: number | null = null;
  let mainHead: string | null = null;
  if (distNewestIso) {
    // The stamp must carry its own timezone.
    //
    // `git rev-list --since` parses a NAIVE timestamp in the LOCAL zone.
    // The old code stripped the zone off a UTC ISO string, so the window
    // was read one offset off — on this host (CET, UTC+1) an hour into the
    // past, and every commit that landed in that hour counted as newer
    // than the build.
    //
    // Measured 2026-11-04 on this host: the S1 merge commit (11:38:00
    // CET) against a build from 11:39:01 CET reported "dist is 1
    // commit(s) behind main" — the commit was 61 seconds OLDER than the
    // build and the build was current. The check that exists to catch a
    // stale deployment was reporting a stale deployment that was not
    // there.
    //
    // The ISO form keeps the zone, so git reads the instant the stamp
    // names rather than the instant it looks like.
    const stamp = new Date(newest as number).toISOString();
    const count = await git(['rev-list', '--count', `--since=${stamp}`, 'main'], repoRoot);
    if (count !== null && /^\d+$/.test(count)) commitsBehind = Number(count);
    mainHead = await git(['log', '-1', '--format=%H', 'main'], repoRoot);
  }

  const sourceNames = CLI_COMMAND_REGISTRY.map((registration) => registration.name);
  const missingCommands: string[] = [];
  try {
    const distRegistry = path.join(distDir, 'infra', 'cli', 'registry.js');
    const module = (await import(pathToFileURL(distRegistry).href)) as {
      CLI_COMMAND_REGISTRY?: { name: string }[];
    };
    const built = new Set((module.CLI_COMMAND_REGISTRY ?? []).map((entry) => entry.name));
    missingCommands.push(...sourceNames.filter((name) => !built.has(name)));
  } catch {
    // The build could not be read — that is a deployment fact too, but the
    // check reports it through the freshness number rather than as a
    // missing command.
  }

  return { commitsBehind, missingCommands, distNewestIso, mainHead };
}

interface BranchFacts {
  /** False when there was no repository to read. */
  measured: boolean;
  pushers: { file: string; line: number; target: string }[];
  rulesetHasRequiredPr: boolean | null;
  rulesetId: string | null;
  /** The branch the ruleset protects — the repository's default branch. */
  protectedBranch: string | null;
}

async function collectBranchBoundary(repoRoot: string | null): Promise<BranchFacts> {
  const pushers: { file: string; line: number; target: string }[] = [];

  if (repoRoot) {
    for (const dir of ['crons', 'scripts']) {
      const absolute = path.join(repoRoot, dir);
      const files = (await fs.readdir(absolute).catch(() => [])).filter((name) =>
        /\.(sh|bash|mts|mjs)$/.test(name),
      );
      for (const file of files) {
        const text = await readTextIfExists(path.join(absolute, file));
        if (!text) continue;
        text.split('\n').forEach((line, index) => {
          const match = /git\s+push[^\n]*?HEAD:refs\/heads\/([A-Za-z0-9._/-]+)/.exec(line);
          if (match) {
            pushers.push({ file: `${dir}/${file}`, line: index + 1, target: match[1] });
          }
        });
      }
    }
  }

  let rulesetHasRequiredPr: boolean | null = null;
  let rulesetId: string | null = null;
  let protectedBranch: string | null = null;
  if (repoRoot) {
    const remote = await git(['remote', 'get-url', 'origin'], repoRoot);
    const slug = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote ?? '')?.[1];
    if (slug) {
      try {
        const { stdout } = await execFileAsync(
          'gh',
          [
            'api',
            `repos/${slug}/rulesets`,
            '--jq',
            '.[] | [.id, ([.rules[].type] | join(","))] | @tsv',
          ],
          { cwd: repoRoot, timeout: 20_000 },
        );
        const first = stdout.trim().split('\n')[0];
        if (first) {
          const [id, types] = first.split('\t');
          rulesetId = id ?? null;
          rulesetHasRequiredPr = (types ?? '').split(',').includes('required_pull_request');
        }
      } catch {
        rulesetHasRequiredPr = null;
      }
      // The protected branch is the repository's default branch. The
      // ruleset's condition names it as ~DEFAULT_BRANCH, which is not a
      // branch name — it is a placeholder the API resolves.
      try {
        const { stdout } = await execFileAsync(
          'gh',
          ['api', `repos/${slug}`, '--jq', '.default_branch'],
          { cwd: repoRoot, timeout: 20_000 },
        );
        const branch = stdout.trim();
        protectedBranch = branch.length > 0 ? branch : null;
      } catch {
        protectedBranch = null;
      }
    }
  }

  return { measured: repoRoot !== null, pushers, rulesetHasRequiredPr, rulesetId, protectedBranch };
}

async function collectGateCoverage(repoRoot: string | null): Promise<{
  measured: boolean;
  misScoped: { gate: string; scope: string }[];
}> {
  if (!repoRoot) return { measured: false, misScoped: [] };
  const misScoped: { gate: string; scope: string }[] = [];

  // 1 · the chain invariant scans a fixture, not the live chains.
  const chainWorkflow = await readTextIfExists(
    path.join(repoRoot, '.github', 'workflows', 'chain-invariant.yml'),
  );
  if (
    chainWorkflow &&
    chainWorkflow.includes('tests/fixtures/chain-invariant') &&
    !chainWorkflow.includes('MEMPHIS_CHAINS')
  ) {
    misScoped.push({
      gate: 'chain-invariant',
      scope: 'scans the committed fixture, never the live chains',
    });
  }

  // 2 · the systemd gate reads one directory; the runtime's own unit is not in it.
  const unitGate = await readTextIfExists(
    path.join(repoRoot, 'scripts', 'check-systemd-units.mts'),
  );
  const unitDirMatch = unitGate ? /UNIT_DIR\s*=\s*resolve\('([^']+)'\)/.exec(unitGate) : null;
  if (unitDirMatch) {
    const opsUnits = (await fs.readdir(path.join(repoRoot, 'ops')).catch(() => [])).filter(
      (name) => name.endsWith('.service') || name.endsWith('.timer'),
    );
    const outside = opsUnits.filter((name) => name !== unitDirMatch[1]);
    if (outside.length > 0) {
      misScoped.push({
        gate: 'check-systemd-units',
        scope: `reads ${unitDirMatch[1]}/ only; never checks ${outside
          .map((name) => `ops/${name}`)
          .join(', ')}`,
      });
    }
  }

  // 3 · cargo audit exists in a script no workflow calls.
  const workflowDir = path.join(repoRoot, '.github', 'workflows');
  const workflowFiles = (await fs.readdir(workflowDir).catch(() => [])).filter(
    (name) => name.endsWith('.yml') || name.endsWith('.yaml'),
  );
  const workflowText = (
    await Promise.all(workflowFiles.map((name) => readTextIfExists(path.join(workflowDir, name))))
  ).join('\n');
  if (workflowText && !/rust-core-safety|cargo audit/.test(workflowText)) {
    misScoped.push({
      gate: 'cargo audit',
      scope: 'the script exists, no workflow invokes it',
    });
  }

  // 4 · the restore drill is an echo.
  const drill = await readTextIfExists(
    path.join(repoRoot, '.github', 'workflows', 'backup-restore-drill.yml'),
  );
  if (drill) {
    // The workflow may NAME the drill inside an echo — that is a notice,
    // not a drill. Only a command line that actually invokes it counts.
    const invokes = drill
      .split('\n')
      .filter((line) => !/\becho\b/.test(line))
      .some((line) => /npm run[^\n]*drill/.test(line));
    if (!invokes) {
      misScoped.push({
        gate: 'backup-restore-drill',
        scope: 'the workflow prints a notice instead of drilling',
      });
    }
  }

  // 5 · the PII scan reads the working tree, not the history.
  const piiScan = await readTextIfExists(path.join(repoRoot, 'scripts', 'pii-scan.sh'));
  if (piiScan && piiScan.includes('git ls-files') && !/rev-list|git log --all/.test(piiScan)) {
    misScoped.push({
      gate: 'pii-scan',
      scope: 'scans the working tree only, never the history',
    });
  }

  // 6 · the secret scan exempts tests by path.
  const secretScan = await readTextIfExists(
    path.join(repoRoot, 'scripts', 'default-secret-scan.sh'),
  );
  if (secretScan && /tests\/\*/.test(secretScan)) {
    misScoped.push({
      gate: 'default-secret-scan',
      scope: 'exempts tests/ and every *.test.* by path',
    });
  }

  return { measured: true, misScoped };
}

async function collectPostmortemStatus(repoRoot: string | null): Promise<{
  total: number;
  indexed: number;
  machineReadable: number;
}> {
  if (!repoRoot) return { total: 0, indexed: 0, machineReadable: 0 };
  const dir = path.join(repoRoot, 'docs', 'postmortems');
  const files = (await fs.readdir(dir).catch(() => [])).filter(
    (name) => name.endsWith('.md') && name !== 'README.md',
  );
  const readme = (await readTextIfExists(path.join(dir, 'README.md'))) ?? '';

  let indexed = 0;
  let machineReadable = 0;
  for (const file of files) {
    if (readme.includes(file)) indexed += 1;
    const text = (await readTextIfExists(path.join(dir, file))) ?? '';
    if (/^\s*[-*]?\s*\*?\*?status\*?\*?\s*[:：]/im.test(text)) machineReadable += 1;
  }

  return { total: files.length, indexed, machineReadable };
}

/* ------------------------------------------------------------------ */
/* the audit                                                           */
/* ------------------------------------------------------------------ */

export async function runRuntimeAudit(
  options: RuntimeAuditOptions = {},
): Promise<RuntimeAuditReport> {
  const rawEnv = options.rawEnv ?? process.env;
  const now = options.now ?? new Date();
  // `repoRoot: null` means "there is no repository here" and must NOT
  // fall back to the search — otherwise a caller that deliberately
  // isolates the audit would silently measure the real one.
  const repoRoot =
    options.repoRoot === undefined ? await findRepoRoot(process.cwd()) : options.repoRoot;

  let config = options.config ?? null;
  if (!config) {
    try {
      config = loadConfig(rawEnv);
    } catch {
      config = null;
    }
  }

  const registryFacts = await collectChainRegistry(rawEnv, repoRoot);
  const vocabularyFacts = await collectBlockVocabulary(rawEnv, registryFacts.effectiveAllowlist);
  const sloFacts = await collectSloReporting(rawEnv, options.windowDays ?? 7);
  const healthFacts = await collectHealthReporting(config, rawEnv);
  const deploymentFacts = await collectDeploymentFreshness(repoRoot);
  const branchFacts = await collectBranchBoundary(repoRoot);
  const gateFacts = await collectGateCoverage(repoRoot);
  const postmortemFacts = await collectPostmortemStatus(repoRoot);

  const checks: AuditCheckResult[] = [
    checkChainRegistry(registryFacts),
    checkBlockVocabulary(vocabularyFacts),
    checkSloReporting(sloFacts),
    healthFacts
      ? checkHealthReporting(healthFacts)
      : {
          id: 'health-reporting',
          title: 'a failing health check reaches the top line',
          verdict: 'unknown',
          summary: 'the health payload could not be built here',
          details: [],
        },
    checkDeploymentFreshness(deploymentFacts),
    checkBranchBoundary(branchFacts),
    checkGateCoverage(gateFacts),
    checkPostmortemStatus(postmortemFacts),
  ];

  const overall = worstVerdict(checks.map((check) => check.verdict));
  const failures = checks.filter((check) => check.verdict === 'failure').length;
  const inconclusive = checks.filter((check) => check.verdict === 'inconclusive').length;
  const unknown = checks.filter((check) => check.verdict === 'unknown').length;

  return {
    checks,
    overall,
    failures,
    inconclusive,
    unknown,
    ok: failures === 0 && inconclusive === 0 && unknown === 0,
    generatedAt: now.toISOString(),
  };
}

/** Render the report the way the operator reads it: one line per check. */
export function renderAuditReport(report: RuntimeAuditReport): string {
  const width = Math.max(...report.checks.map((check) => check.id.length));
  const lines: string[] = [];
  for (const check of report.checks) {
    lines.push(
      `${check.id.padEnd(width)}  ${check.verdict.toUpperCase().padEnd(12)}  ${check.summary}`,
    );
    for (const detail of check.details) {
      lines.push(`${' '.repeat(width + 2)}${detail}`);
    }
  }
  lines.push(
    `overall: ${report.overall.toUpperCase()} (${report.failures} open, ${report.inconclusive} inconclusive, ${report.unknown} unknown)`,
  );
  lines.push(`generated: ${report.generatedAt}`);
  return lines.join('\n');
}
