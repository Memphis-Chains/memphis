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

import type { SkillFact } from './skill-facts.js';
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
  /** Catalog names that are expected on a live host. */
  readonly standardChainNames: readonly string[];
  /** Catalog names whose absence is not drift (`proactive`, `messages`). */
  readonly conditionalChainNames: readonly string[];
  /** The registry derived from the taxonomy and the disk. */
  readonly registryNames: readonly string[];
  /** The registry entries that are archives of a chain (`journal.backup-…`). */
  readonly registryArchiveNames: readonly string[];
  /** The allowlist in force right now (the registry, narrowed by the config). */
  readonly effectiveAllowlist: readonly string[];
  /** The allowlist as written in the live `.env`, if the file was found. */
  readonly configAllowlist: readonly string[] | null;
  /** Every chain directory on disk. */
  readonly diskDirs: readonly string[];
  /** The directories the verifier will actually open. */
  readonly scannableDirs: readonly string[];
}

/**
 * The registry is one list — and the list knows the difference between
 * "planned" and "drifted".
 *
 * What is drift:
 *   - a chain the registry names is not effectively scanned (the config
 *     narrowed it away, or its name is not safe). This is the hole the
 *     operator named: the allowlist carried three archives the scanner
 *     could not open, so a backup he had explicitly listed was never
 *     read.
 *   - the config names a chain the registry does not know. The config
 *     may only narrow; it may not invent.
 *
 * What is NOT drift:
 *   - a conditional chain (`proactive`, `messages`) with no directory.
 *     The taxonomy is not a promise about the disk, and a host without
 *     the federation chain is healthy.
 *   - a directory under `chains/` that is not a chain (the quarantine
 *     container, a sidecar writer's dump). It is reported for
 *     visibility, and the verifier must not open it.
 */
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
  const registry = new Set(input.registryNames);
  const disk = new Set(input.diskDirs);
  const scannable = new Set(input.scannableDirs);
  const archives = new Set(input.registryArchiveNames);

  const registryNotScanned = input.registryNames.filter((name) => !effective.has(name));
  // Narrowing a CHAIN away is drift: it is a directory Memphis writes to.
  // Narrowing an ARCHIVE away is the operator's explicit choice — the
  // config exists precisely so the operator can decide which frozen
  // copies are read — so it is reported, not failed.
  const chainsNotScanned = registryNotScanned.filter((name) => !archives.has(name));
  const archivesNotScanned = registryNotScanned.filter((name) => archives.has(name));
  const unreachable = registryNotScanned.filter((name) => disk.has(name) && !scannable.has(name));
  const configOnly = (input.configAllowlist ?? []).filter((name) => !registry.has(name));
  const allowlistedButUnscanned = input.effectiveAllowlist.filter(
    (name) => disk.has(name) && !scannable.has(name),
  );
  const conditionalAbsent = input.conditionalChainNames.filter(
    (name) => !disk.has(name) && !effective.has(name),
  );
  const standardAbsent = input.standardChainNames.filter(
    (name) => !disk.has(name) && !effective.has(name),
  );
  const notAChain = input.diskDirs.filter((name) => !registry.has(name));

  const details: string[] = [];
  if (chainsNotScanned.length > 0) {
    details.push(
      `in the registry but not scanned: ${chainsNotScanned.join(', ')} — the config narrowed them away`,
    );
  }
  if (archivesNotScanned.length > 0) {
    details.push(
      `archives narrowed out of the scan by the config (the operator's choice): ${archivesNotScanned.join(', ')}`,
    );
  }
  if (unreachable.length > 0) {
    details.push(
      `in the registry but unreachable by the scanner (the name is not safe): ${unreachable.join(', ')}`,
    );
  }
  if (configOnly.length > 0) {
    details.push(
      `named by the config but not by the registry (the config may only narrow): ${configOnly.join(', ')}`,
    );
  }
  if (allowlistedButUnscanned.length > 0) {
    details.push(
      `in the allowlist but unreachable by the scanner (the name is not safe): ${allowlistedButUnscanned.join(', ')}`,
    );
  }
  if (conditionalAbsent.length > 0) {
    details.push(
      `planned, not installed — their absence is not drift: ${conditionalAbsent.join(', ')}`,
    );
  }
  if (standardAbsent.length > 0) {
    details.push(`in the taxonomy, no directory yet: ${standardAbsent.join(', ')}`);
  }
  if (notAChain.length > 0) {
    details.push(`on disk, not a chain: ${notAChain.join(', ')}`);
  }

  const drift = chainsNotScanned.length > 0 ? chainsNotScanned.join(',') : 'none';
  const verdict =
    chainsNotScanned.length > 0 || configOnly.length > 0 || allowlistedButUnscanned.length > 0
      ? FAIL
      : PASS;

  return {
    id: 'chain-registry',
    title,
    verdict,
    summary: `catalog=${input.catalogNames.length} registry=${input.registryNames.length} scanned=${input.effectiveAllowlist.length} disk=${input.diskDirs.length} drift=${drift}`,
    details,
  };
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
    // "SCANNABLE", not "live": the count covers every directory the
    // verifier may open, and that set includes the chain ARCHIVES the
    // operator allowlisted — 747 of the 11 975 blocks on this host were
    // copies of a chain, not new memory. The old wording said "live"
    // and was wrong by those 747.
    summary: `${input.unreadable.length} of ${input.totalBlocks} scannable blocks cannot be parsed by the core`,
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
  /**
   * The branch the boundary protects — the repository's default branch.
   *
   * Measured 2026-11-10: the check was called "no script pushes HEAD to
   * main" but every push was counted as a violation, including a push to
   * a feature branch. A script that publishes through a branch and a pull
   * request is exactly what the ruleset wants, and the check reported it
   * as a hole. The check has to measure what its own title says, or the
   * operator learns to ignore it.
   *
   * Null when the default branch could not be read; then every push is
   * reported, because the protected branch is not known.
   */
  readonly protectedBranch: string | null;
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

  // With the protected branch known, a push to any OTHER branch is not a
  // boundary violation — it is a branch. Only a push to the protected
  // branch is. When it is not known, every push is reported: an unknown
  // boundary is not a boundary that can be assumed away.
  const violations = input.pushers.filter(
    (pusher) => input.protectedBranch === null || pusher.target === input.protectedBranch,
  );

  const details: string[] = [];
  for (const pusher of violations) {
    details.push(`${pusher.file}:${pusher.line} pushes ${pusher.target}`);
  }
  for (const pusher of input.pushers) {
    if (violations.includes(pusher)) continue;
    details.push(
      `${pusher.file}:${pusher.line} pushes ${pusher.target} (not the protected branch)`,
    );
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
    verdict: violations.length > 0 ? FAIL : PASS,
    summary:
      violations.length > 0
        ? `${violations.length} script(s) push HEAD to ${input.protectedBranch ?? 'a protected branch'}`
        : input.pushers.length > 0
          ? `no script pushes HEAD to ${input.protectedBranch ?? 'the protected branch'} (${input.pushers.length} push(es) to other branches)`
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
  /** Documents whose declared status contradicts their own open-item list. */
  readonly inconsistent?: readonly { readonly file: string; readonly reason: string }[];
  /** Documents with no status a program can read. */
  readonly withoutStatus?: readonly string[];
  /** Documents with still-open work, with the count. */
  readonly open?: readonly { readonly file: string; readonly openItems: number }[];
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

  const inconsistent = input.inconsistent ?? [];
  const withoutStatus = input.withoutStatus ?? [];
  const open = input.open ?? [];

  // A document whose header contradicts its own body is worse than a
  // document with no status at all: the first one is a claim that can be
  // disproved, the second one is an absence nobody trusted. Both
  // fail the check.
  const gap = input.total - input.machineReadable;
  const details: string[] = [];

  if (gap > 0) {
    // Name the documents. A failure that says "3 of 11" without saying
    // WHICH three sends the reader back to the directory listing to
    // find them, which is the manual step this whole check exists to
    // remove.
    if (withoutStatus.length > 0) {
      details.push(
        `${withoutStatus.length} postmortem(s) carry no status a tool can read: ${withoutStatus.join(', ')}`,
      );
    } else {
      details.push(`${gap} postmortem(s) carry no status a tool can read`);
    }
  }
  for (const entry of inconsistent) {
    details.push(`${entry.file}: ${entry.reason}`);
  }

  // The open items are NOT a failure. A corpus that says "still open"
  // is a corpus doing its job; a corpus that cannot say it is the
  // hole. So they are reported, not blocked on.
  const openSummary = open.length
    ? ` open=${open.reduce((sum, entry) => sum + entry.openItems, 0)} in ${open.length} document(s)`
    : '';

  return {
    id: 'postmortem-status',
    title,
    verdict: gap > 0 || inconsistent.length > 0 ? FAIL : PASS,
    summary: `indexed=${input.indexed}/${input.total} machine-readable status=${input.machineReadable}/${input.total}${openSummary}`,
    details,
  };
}

/* ------------------------------------------------------------------ */
/* S9 · one truth for the skills                                      */
/* ------------------------------------------------------------------ */

export interface SkillCatalogInput {
  /** The skills the repository declares (`skills/<id>/`). */
  readonly repoSkills: readonly SkillFact[];
  /** The skills materialized in the runtime catalog (`~/.memphis/skills/catalog/<id>/`). */
  readonly catalogSkills: readonly SkillFact[];
  /** The skills registered as installed (`~/.memphis/skills/installed/<id>/`). */
  readonly installedSkills: readonly SkillFact[];
}

/**
 * The skills are one truth, and the runtime holds the copy of it.
 *
 * What is drift:
 *   - a repository skill that the runtime does not know. The MCP
 *     server reads the runtime catalog, so such a skill is INVISIBLE:
 *     `memphis skills show` answers "manifest not found" and no tool
 *     can reach it. Measured on this host before this check existed:
 *     the HALT skill — the guard every destructive operation goes
 *     through — was one of them.
 *   - a repository skill with no manifest at all. It cannot be
 *     materialized, so it can never reach the runtime.
 *   - a materialized copy whose content differs from the repository
 *     copy. The copy is fine; the copy WITHOUT A COMPARISON is not.
 *
 * What is NOT drift:
 *   - a skill that lives only in the runtime. Those are the operator's
 *     host skills (`jdg-psa-plan-editor`, `vault-pat-verify`); the
 *     repository is not obliged to carry them. They are reported, so
 *     the reader can see where a skill lives.
 */
export function checkSkillCatalog(input: SkillCatalogInput): AuditCheckResult {
  const title = 'the skills are one truth, and the runtime holds the copy';
  if (input.repoSkills.length === 0) {
    return {
      id: 'skill-catalog',
      title,
      verdict: UNKNOWN,
      summary: 'the repository skills directory could not be read',
      details: [],
    };
  }

  const catalog = new Map(input.catalogSkills.map((fact) => [fact.id, fact]));
  const installed = new Map(input.installedSkills.map((fact) => [fact.id, fact]));

  const details: string[] = [];
  const missingFromCatalog: string[] = [];
  const missingFromInstalled: string[] = [];
  const drifted: string[] = [];
  const withoutManifest: string[] = [];

  for (const repoSkill of input.repoSkills) {
    if (!repoSkill.manifestDigest) {
      withoutManifest.push(repoSkill.id);
      continue;
    }

    const catalogFact = catalog.get(repoSkill.id);
    const installedFact = installed.get(repoSkill.id);
    if (!catalogFact) {
      missingFromCatalog.push(repoSkill.id);
    }
    if (!installedFact) {
      missingFromInstalled.push(repoSkill.id);
    }

    // Compare against the installed copy when there is one — that is the
    // copy the runtime actually serves — and against the catalog copy
    // otherwise, so a half-materialized skill still reports its drift.
    const runtimeFact = installedFact ?? catalogFact;
    if (!runtimeFact) continue;

    if (repoSkill.skillMdDigest !== runtimeFact.skillMdDigest) {
      drifted.push(`${repoSkill.id} (SKILL.md differs)`);
    }
    if (repoSkill.manifestDigest !== runtimeFact.manifestDigest) {
      drifted.push(`${repoSkill.id} (manifest differs)`);
    }
    if (runtimeFact.manifestUnreadable) {
      drifted.push(`${repoSkill.id} (runtime manifest unreadable)`);
    }
  }

  const repoIds = new Set(input.repoSkills.map((fact) => fact.id));
  const runtimeOnly = [...new Set([...catalog.keys(), ...installed.keys()])]
    .filter((id) => !repoIds.has(id))
    .sort((left, right) => left.localeCompare(right));

  if (withoutManifest.length > 0) {
    details.push(`no manifest, so it can never reach the runtime: ${withoutManifest.join(', ')}`);
  }
  if (missingFromCatalog.length > 0) {
    details.push(
      `in the repository but not in the runtime catalog — invisible to the MCP server: ${missingFromCatalog.join(', ')}`,
    );
  }
  if (missingFromInstalled.length > 0) {
    details.push(`in the repository but not installed: ${missingFromInstalled.join(', ')}`);
  }
  if (drifted.length > 0) {
    details.push(`the runtime copy differs from the repository copy: ${drifted.join(', ')}`);
  }
  if (runtimeOnly.length > 0) {
    details.push(`living only in the runtime (operator host skills): ${runtimeOnly.join(', ')}`);
  }

  const failed =
    withoutManifest.length > 0 ||
    missingFromCatalog.length > 0 ||
    missingFromInstalled.length > 0 ||
    drifted.length > 0;

  return {
    id: 'skill-catalog',
    title,
    verdict: failed ? FAIL : PASS,
    summary: `repo=${input.repoSkills.length} catalog=${input.catalogSkills.length} installed=${input.installedSkills.length} drift=${drifted.length || 'none'} invisible=${missingFromCatalog.length || 'none'}`,
    details,
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
  'skill-catalog',
] as const;
