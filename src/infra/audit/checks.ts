/**
 * The audit's checks — eight of them, one per hole measured in
 * `docs/design/MEMPHIS-HOLES-AND-REFACTOR.md` §1.
 *
 * Each check is a PURE function over values the collector gathered
 * from the live system. That split is deliberate: the check can be
 * tested against a synthetic host (what a unit test does), and the
 * collector can be tested against the real one. Neither can quietly
 * disagree with the other, because neither computes the verdict — the
 * check does, from numbers that came from somewhere.
 *
 * A check fails when the host is wrong. It reports `unknown` when the
 * host cannot be reached — never `success`. That is the difference
 * between this and the six gates it replaces.
 */

import type { AuditCheckResult } from './types.js';

const PASS: AuditCheckResult['verdict'] = 'success';
const FAIL: AuditCheckResult['verdict'] = 'failure';
const UNKNOWN: AuditCheckResult['verdict'] = 'unknown';

/* ------------------------------------------------------------------ */
/* H2 · one registry                                                   */
/* ------------------------------------------------------------------ */

export interface ChainRegistryInput {
  /** Names in the taxonomy (`src/memory/chain-catalog.ts`). */
  readonly catalogNames: readonly string[];
  /** The code's default allowlist, with no env override applied. */
  readonly codeAllowlist: readonly string[];
  /** The allowlist in force right now (the env override wins). */
  readonly effectiveAllowlist: readonly string[];
  /** The allowlist as written in the live `.env`, if the file was found. */
  readonly configAllowlist: readonly string[] | null;
  /** Every chain directory on disk. */
  readonly diskDirs: readonly string[];
  /** The directories the verifier will actually open (safe-name filter applied). */
  readonly scannableDirs: readonly string[];
}

export function checkChainRegistry(input: ChainRegistryInput): AuditCheckResult {
  const title = 'the chain registry is one list';
  if (input.catalogNames.length === 0 || input.diskDirs.length === 0) {
    return {
      id: 'chain-registry',
      title,
      verdict: UNKNOWN,
      summary: 'the taxonomy or the chains directory could not be read',
      details: [],
    };
  }

  const effective = new Set(input.effectiveAllowlist);
  const disk = new Set(input.diskDirs);
  const scannable = new Set(input.scannableDirs);

  const catalogOnly = input.catalogNames.filter((name) => !effective.has(name));
  const allowlistOnly = input.effectiveAllowlist.filter((name) => !disk.has(name));
  const unscanned = input.diskDirs.filter((name) => !effective.has(name));
  const allowlistedButUnscanned = input.effectiveAllowlist.filter(
    (name) => disk.has(name) && !scannable.has(name),
  );
  const configDiffersFromCode =
    input.configAllowlist !== null && !sameSet(input.configAllowlist, input.codeAllowlist);

  const details: string[] = [];
  if (catalogOnly.length > 0) {
    details.push(`in the taxonomy only: ${catalogOnly.join(', ')}`);
  }
  if (allowlistOnly.length > 0) {
    details.push(`in the allowlist but no directory: ${allowlistOnly.join(', ')}`);
  }
  if (unscanned.length > 0) {
    details.push(`on disk but never scanned: ${unscanned.join(', ')}`);
  }
  if (allowlistedButUnscanned.length > 0) {
    details.push(
      `in the allowlist but unreachable by the scanner (the name is not safe): ${allowlistedButUnscanned.join(', ')}`,
    );
  }
  if (configDiffersFromCode) {
    details.push(
      'the live .env allowlist differs from the code default — the config overrides the code silently',
    );
  }

  const drift = catalogOnly.length > 0 ? catalogOnly.join(',') : 'none';
  const verdict =
    catalogOnly.length > 0 ||
    allowlistOnly.length > 0 ||
    unscanned.length > 0 ||
    allowlistedButUnscanned.length > 0 ||
    configDiffersFromCode
      ? FAIL
      : PASS;

  return {
    id: 'chain-registry',
    title,
    verdict,
    summary: `catalog=${input.catalogNames.length} allowlist=${input.effectiveAllowlist.length} disk=${input.diskDirs.length} drift=${drift}`,
    details,
  };
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = new Set(a);
  return b.every((value) => left.has(value));
}

/* ------------------------------------------------------------------ */
/* H1 · one vocabulary                                                 */
/* ------------------------------------------------------------------ */

export interface UnreadableBlock {
  readonly chain: string;
  readonly file: string;
  readonly type?: string;
  readonly error: string;
}

export interface BlockVocabularyInput {
  /** False when the native core could not be loaded — the check cannot measure. */
  readonly oracleAvailable: boolean;
  readonly totalBlocks: number;
  readonly unreadable: readonly UnreadableBlock[];
  readonly chainsScanned: number;
}

export function checkBlockVocabulary(input: BlockVocabularyInput): AuditCheckResult {
  const title = 'the core and the verifier agree on a valid block';
  if (!input.oracleAvailable) {
    return {
      id: 'block-vocabulary',
      title,
      verdict: UNKNOWN,
      summary: 'the native core is not available, so no block could be validated',
      details: [],
    };
  }

  if (input.totalBlocks === 0) {
    return {
      id: 'block-vocabulary',
      title,
      verdict: UNKNOWN,
      summary: 'no live block was found to validate',
      details: [],
    };
  }

  const details = input.unreadable.map(
    (block) =>
      `${block.chain}/${block.file}: ${block.type ? `type=${block.type} ` : ''}${block.error}`,
  );

  return {
    id: 'block-vocabulary',
    title,
    verdict: input.unreadable.length > 0 ? FAIL : PASS,
    summary: `${input.unreadable.length} of ${input.totalBlocks} live blocks cannot be parsed by the core`,
    details,
  };
}

/* ------------------------------------------------------------------ */
/* H3 · the SLO report must not lie                                   */
/* ------------------------------------------------------------------ */

export interface SloReportingInput {
  readonly metrics: readonly { readonly name: string; readonly status: string }[];
  /** The verdict the live report prints right now. */
  readonly verdictPassing: boolean;
}

export function checkSloReporting(input: SloReportingInput): AuditCheckResult {
  const title = 'the SLO report does not pass on metrics that have no data';
  if (input.metrics.length === 0) {
    return {
      id: 'slo-reporting',
      title,
      verdict: UNKNOWN,
      summary: 'no SLO metrics could be evaluated',
      details: [],
    };
  }

  const unavailable = input.metrics.filter((metric) => metric.status === 'unavailable');
  const lying = input.verdictPassing && unavailable.length > 0;

  return {
    id: 'slo-reporting',
    title,
    verdict: lying ? FAIL : PASS,
    summary: `${unavailable.length} of ${input.metrics.length} metrics unavailable; verdict=${input.verdictPassing ? 'passing' : 'not passing'}`,
    details: lying ? unavailable.map((metric) => `${metric.name}: no samples in the window`) : [],
  };
}

/* ------------------------------------------------------------------ */
/* H4 · the health report must not hide a failing check                */
/* ------------------------------------------------------------------ */

export interface HealthReportingInput {
  readonly topLine: string;
  readonly failing: readonly string[];
}

export function checkHealthReporting(input: HealthReportingInput): AuditCheckResult {
  const title = 'a failing health check reaches the top line';
  // Only the green top lines hide a failure. `degraded` is the health
  // payload already saying something is wrong — it is not a hidden
  // failure, it is a visible one.
  const hidden = input.failing.length > 0 && /^(ok|healthy)$/i.test(input.topLine);

  return {
    id: 'health-reporting',
    title,
    verdict: hidden ? FAIL : PASS,
    summary: `${input.failing.length} failing check(s); top-line=${input.topLine}`,
    details: input.failing.map((name) => `checks.${name}=fail`),
  };
}

/* ------------------------------------------------------------------ */
/* H5 · the deployed artifact is the repository                        */
/* ------------------------------------------------------------------ */

export interface DeploymentFreshnessInput {
  /** Commits on `main` that are newer than the newest built file. Null when unknown. */
  readonly commitsBehind: number | null;
  /** Commands the source registers and the build does not know. */
  readonly missingCommands: readonly string[];
  readonly distNewestIso: string | null;
  readonly mainHead: string | null;
}

export function checkDeploymentFreshness(input: DeploymentFreshnessInput): AuditCheckResult {
  const title = 'the running artifact is the repository';
  if (input.commitsBehind === null && input.missingCommands.length === 0) {
    return {
      id: 'deployment-freshness',
      title,
      verdict: UNKNOWN,
      summary: 'neither the build age nor the command list could be measured',
      details: [],
    };
  }

  const behind = input.commitsBehind ?? 0;
  const stale = behind > 0 || input.missingCommands.length > 0;

  const details: string[] = [];
  if (input.commitsBehind !== null) {
    details.push(`newest built file: ${input.distNewestIso ?? 'unknown'}`);
    details.push(`main head: ${input.mainHead ?? 'unknown'}`);
  }
  if (input.missingCommands.length > 0) {
    details.push(`missing from the build: ${input.missingCommands.join(', ')}`);
  }

  return {
    id: 'deployment-freshness',
    title,
    verdict: stale ? FAIL : PASS,
    summary: `dist is ${behind} commit(s) behind main; ${input.missingCommands.length} cli command(s) missing`,
    details,
  };
}

/* ------------------------------------------------------------------ */
/* H6 · writers may not bypass the branch boundary                     */
/* ------------------------------------------------------------------ */

export interface BranchBoundaryInput {
  /** False when the repository could not be read — then the check cannot know. */
  readonly measured: boolean;
  readonly pushers: readonly {
    readonly file: string;
    readonly line: number;
    readonly target: string;
  }[];
  /** Whether the repository ruleset requires a pull request. Null when unknown. */
  readonly rulesetHasRequiredPr: boolean | null;
  readonly rulesetId: string | null;
}

export function checkBranchBoundary(input: BranchBoundaryInput): AuditCheckResult {
  const title = 'no script pushes HEAD to main';
  if (!input.measured) {
    return {
      id: 'branch-boundary',
      title,
      verdict: UNKNOWN,
      summary: 'the repository could not be read, so no script could be checked',
      details: [],
    };
  }

  const details: string[] = [];
  for (const pusher of input.pushers) {
    details.push(`${pusher.file}:${pusher.line} pushes ${pusher.target}`);
  }
  if (input.rulesetId) {
    details.push(
      `ruleset ${input.rulesetId} ${
        input.rulesetHasRequiredPr === true
          ? 'requires a pull request'
          : input.rulesetHasRequiredPr === false
            ? 'does not require a pull request'
            : 'could not be read'
      }`,
    );
  }

  return {
    id: 'branch-boundary',
    title,
    verdict: input.pushers.length > 0 ? FAIL : PASS,
    summary:
      input.pushers.length > 0
        ? `${input.pushers.length} script(s) push HEAD to a protected branch`
        : 'no script pushes HEAD to a protected branch',
    details,
  };
}

/* ------------------------------------------------------------------ */
/* H7 · the gates measure what can fail                                */
/* ------------------------------------------------------------------ */

export interface GateCoverageInput {
  /** False when the gate files could not be read at all. */
  readonly measured: boolean;
  readonly misScoped: readonly { readonly gate: string; readonly scope: string }[];
}

export function checkGateCoverage(input: GateCoverageInput): AuditCheckResult {
  const title = 'every gate can fail on this host';
  if (!input.measured) {
    return {
      id: 'gate-coverage',
      title,
      verdict: UNKNOWN,
      summary: 'the gate files could not be read',
      details: [],
    };
  }

  return {
    id: 'gate-coverage',
    title,
    verdict: input.misScoped.length > 0 ? FAIL : PASS,
    summary: `${input.misScoped.length} gate(s) measure a scope that cannot fail on this host`,
    details: input.misScoped.map((gate) => `${gate.gate}: ${gate.scope}`),
  };
}

/* ------------------------------------------------------------------ */
/* H8 · the postmortem corpus can say what is still open               */
/* ------------------------------------------------------------------ */

export interface PostmortemStatusInput {
  readonly total: number;
  readonly indexed: number;
  readonly machineReadable: number;
}

export function checkPostmortemStatus(input: PostmortemStatusInput): AuditCheckResult {
  const title = 'the postmortem corpus says what is still open';
  if (input.total === 0) {
    return {
      id: 'postmortem-status',
      title,
      verdict: UNKNOWN,
      summary: 'no postmortems were found',
      details: [],
    };
  }

  const gap = input.total - input.machineReadable;
  return {
    id: 'postmortem-status',
    title,
    verdict: gap > 0 ? FAIL : PASS,
    summary: `indexed=${input.indexed}/${input.total} machine-readable status=${input.machineReadable}/${input.total}`,
    details: gap > 0 ? [`${gap} postmortem(s) carry no status a tool can read`] : [],
  };
}

export const AUDIT_CHECK_IDS = [
  'chain-registry',
  'block-vocabulary',
  'slo-reporting',
  'health-reporting',
  'deployment-freshness',
  'branch-boundary',
  'gate-coverage',
  'postmortem-status',
] as const;
