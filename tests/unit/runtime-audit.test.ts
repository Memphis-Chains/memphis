/**
 * The runtime audit — unit tests.
 *
 * Two contracts are tested here.
 *
 * 1. Each check is a pure function of measured numbers. Given a host in
 *    a known state it returns a known verdict — including `unknown`
 *    when the host could not be reached, which is the whole reason the
 *    audit exists: the old gates could not tell "fine" from "not
 *    looking".
 *
 * 2. The verdict MOVES when the state moves. A check that cannot change
 *    its answer is not a check. That is the falsifier of the falsifier
 *    (docs/design/MEMPHIS-HOLES-AND-REFACTOR.md §3.1), so every failure
 *    case is paired with the state that makes it pass.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkBlockVocabulary,
  checkBranchBoundary,
  checkChainRegistry,
  checkDeploymentFreshness,
  checkGateCoverage,
  checkHealthReporting,
  checkPostmortemStatus,
  checkSloReporting,
  AUDIT_CHECK_IDS,
} from '../../src/infra/audit/checks.js';
import { renderAuditReport, runRuntimeAudit } from '../../src/infra/audit/runtime-audit.js';
import { isOpenVerdict, worstVerdict } from '../../src/infra/audit/types.js';

describe('runtime audit · the verdict vocabulary', () => {
  it('orders the four states the way the operator reads them', () => {
    expect(worstVerdict(['success', 'success'])).toBe('success');
    expect(worstVerdict(['success', 'unknown'])).toBe('unknown');
    expect(worstVerdict(['success', 'unknown', 'inconclusive'])).toBe('inconclusive');
    expect(worstVerdict(['success', 'unknown', 'inconclusive', 'failure'])).toBe('failure');
  });

  it('treats everything but success as open', () => {
    expect(isOpenVerdict('success')).toBe(false);
    expect(isOpenVerdict('failure')).toBe(true);
    expect(isOpenVerdict('inconclusive')).toBe(true);
    expect(isOpenVerdict('unknown')).toBe(true);
  });
});

describe('runtime audit · chain registry (H2)', () => {
  const clean = {
    catalogNames: ['journal', 'decisions', 'proactive', 'messages'],
    standardChainNames: ['journal', 'decisions'],
    conditionalChainNames: ['proactive', 'messages'],
    registryNames: ['journal', 'decisions'],
    registryArchiveNames: [],
    effectiveAllowlist: ['journal', 'decisions'],
    configAllowlist: ['journal', 'decisions'],
    diskDirs: ['journal', 'decisions'],
    scannableDirs: ['journal', 'decisions'],
  };

  it('passes when the registry, the config and the disk agree', () => {
    expect(checkChainRegistry(clean).verdict).toBe('success');
  });

  it('does not call a planned chain drift when it is not installed', () => {
    // `proactive` and `messages` belong to features that may be off. A
    // host without them is healthy — measured on this host: the audit
    // used to report them as registry drift on every run.
    const result = checkChainRegistry(clean);
    expect(result.verdict).toBe('success');
    expect(result.details.join(' ')).toContain('planned, not installed');
    expect(result.details.join(' ')).toContain('proactive');
  });

  it('fails when the config narrows a chain away', () => {
    const result = checkChainRegistry({
      ...clean,
      registryNames: ['journal', 'decisions'],
      effectiveAllowlist: ['journal'],
      configAllowlist: ['journal'],
    });
    expect(result.verdict).toBe('failure');
    expect(result.details.join(' ')).toContain('not scanned');
    expect(result.details.join(' ')).toContain('decisions');
  });

  it('reports an archive the config narrowed away without failing', () => {
    // Narrowing a FROZEN BACKUP out of the scan is the operator's
    // choice — the config exists for exactly that. It is reported, not
    // failed.
    const result = checkChainRegistry({
      ...clean,
      registryNames: ['journal', 'decisions', 'journal.backup-1784913076785'],
      registryArchiveNames: ['journal.backup-1784913076785'],
      diskDirs: [...clean.diskDirs, 'journal.backup-1784913076785'],
      scannableDirs: [...clean.scannableDirs, 'journal.backup-1784913076785'],
      configAllowlist: ['journal', 'decisions'],
    });
    expect(result.verdict).toBe('success');
    expect(result.details.join(' ')).toContain('archives narrowed out of the scan');
  });

  it('fails when the config names a chain the registry does not know', () => {
    const result = checkChainRegistry({
      ...clean,
      configAllowlist: ['journal', 'decisions', 'ghost'],
    });
    expect(result.verdict).toBe('failure');
    expect(result.details.join(' ')).toContain('may only narrow');
    expect(result.details.join(' ')).toContain('ghost');
  });

  it('fails on an allowlisted chain the scanner cannot open', () => {
    const result = checkChainRegistry({
      ...clean,
      registryNames: [...clean.registryNames, 'journal.backup-1'],
      effectiveAllowlist: [...clean.effectiveAllowlist, 'journal.backup-1'],
      diskDirs: [...clean.diskDirs, 'journal.backup-1'],
      scannableDirs: [...clean.scannableDirs],
    });
    expect(result.verdict).toBe('failure');
    expect(result.details.join(' ')).toContain('journal.backup-1');
  });

  it('reports a directory that is not a chain without failing', () => {
    // The quarantine container and sidecar writers' dumps live under
    // chains/ — they are not chains, and the verifier must not open them.
    const result = checkChainRegistry({ ...clean, diskDirs: [...clean.diskDirs, '_quarantine'] });
    expect(result.verdict).toBe('success');
    expect(result.details.join(' ')).toContain('_quarantine');
  });

  it('says unknown when it cannot read the taxonomy or the disk', () => {
    expect(checkChainRegistry({ ...clean, catalogNames: [] }).verdict).toBe('unknown');
    expect(checkChainRegistry({ ...clean, diskDirs: [] }).verdict).toBe('unknown');
  });
});

describe('runtime audit · block vocabulary (H1)', () => {
  it('fails when the core cannot read a live block', () => {
    const result = checkBlockVocabulary({
      oracleAvailable: true,
      totalBlocks: 23388,
      unreadable: [
        { chain: 'autonom_archive', file: '000001.json', type: 'autonom_publication', error: 'x' },
      ],
      chainsScanned: 14,
    });
    expect(result.verdict).toBe('failure');
    expect(result.summary).toContain('1 of 23388');
  });

  it('passes when every block parses', () => {
    const result = checkBlockVocabulary({
      oracleAvailable: true,
      totalBlocks: 100,
      unreadable: [],
      chainsScanned: 3,
    });
    expect(result.verdict).toBe('success');
  });

  it('says unknown when the native core is not there', () => {
    const result = checkBlockVocabulary({
      oracleAvailable: false,
      totalBlocks: 0,
      unreadable: [],
      chainsScanned: 0,
    });
    expect(result.verdict).toBe('unknown');
  });

  it('says unknown when there was no live block to validate', () => {
    const result = checkBlockVocabulary({
      oracleAvailable: true,
      totalBlocks: 0,
      unreadable: [],
      chainsScanned: 0,
    });
    expect(result.verdict).toBe('unknown');
  });
});

describe('runtime audit · the SLO report (H3)', () => {
  it('fails when the verdict passes on metrics that have no data', () => {
    const result = checkSloReporting({
      metrics: [
        { name: 'tool_error_rate', status: 'unavailable' },
        { name: 'p99_turn_latency_ms', status: 'unavailable' },
      ],
      verdictPassing: true,
    });
    expect(result.verdict).toBe('failure');
    expect(result.summary).toContain('2 of 2 metrics unavailable');
  });

  it('passes once the report stops calling an empty window "passing"', () => {
    const result = checkSloReporting({
      metrics: [{ name: 'tool_error_rate', status: 'unavailable' }],
      verdictPassing: false,
    });
    expect(result.verdict).toBe('success');
  });

  it('passes when every metric has samples and passes', () => {
    const result = checkSloReporting({
      metrics: [{ name: 'tool_error_rate', status: 'pass' }],
      verdictPassing: true,
    });
    expect(result.verdict).toBe('success');
  });

  it('says unknown when no metric could be evaluated', () => {
    expect(checkSloReporting({ metrics: [], verdictPassing: false }).verdict).toBe('unknown');
  });
});

describe('runtime audit · the health report (H4)', () => {
  it('fails when a check fails and the top line says healthy', () => {
    const result = checkHealthReporting({
      topLine: 'healthy',
      failing: ['embed_index_dimension'],
    });
    expect(result.verdict).toBe('failure');
    expect(result.details.join(' ')).toContain('embed_index_dimension');
  });

  it('passes once the failing check reaches the top line', () => {
    const result = checkHealthReporting({
      topLine: 'degraded',
      failing: ['embed_index_dimension'],
    });
    expect(result.verdict).toBe('success');
  });

  it('passes when nothing failed', () => {
    expect(checkHealthReporting({ topLine: 'healthy', failing: [] }).verdict).toBe('success');
  });
});

describe('runtime audit · deployment freshness (H5)', () => {
  it('fails when the build is behind main', () => {
    const result = checkDeploymentFreshness({
      commitsBehind: 13,
      missingCommands: [],
      distNewestIso: '2026-11-01T23:46:28.476Z',
      mainHead: 'abc',
    });
    expect(result.verdict).toBe('failure');
    expect(result.summary).toContain('13 commit(s) behind');
  });

  it('fails when the build does not know a command the source has', () => {
    const result = checkDeploymentFreshness({
      commitsBehind: 0,
      missingCommands: ['dream'],
      distNewestIso: '2026-11-03T21:00:00.000Z',
      mainHead: 'abc',
    });
    expect(result.verdict).toBe('failure');
  });

  it('passes when the build is current', () => {
    const result = checkDeploymentFreshness({
      commitsBehind: 0,
      missingCommands: [],
      distNewestIso: '2026-11-03T21:00:00.000Z',
      mainHead: 'abc',
    });
    expect(result.verdict).toBe('success');
  });

  it('says unknown when neither number could be measured', () => {
    const result = checkDeploymentFreshness({
      commitsBehind: null,
      missingCommands: [],
      distNewestIso: null,
      mainHead: null,
    });
    expect(result.verdict).toBe('unknown');
  });
});

describe('runtime audit · the branch boundary (H6)', () => {
  it('fails when a script pushes HEAD to a protected branch', () => {
    const result = checkBranchBoundary({
      measured: true,
      pushers: [{ file: 'crons/tuesday-code.sh', line: 155, target: 'main' }],
      rulesetHasRequiredPr: false,
      rulesetId: '14186283',
      protectedBranch: 'main',
    });
    expect(result.verdict).toBe('failure');
    expect(result.details.join(' ')).toContain('crons/tuesday-code.sh:155');
  });

  it('passes when no script does that', () => {
    const result = checkBranchBoundary({
      measured: true,
      pushers: [],
      rulesetHasRequiredPr: false,
      rulesetId: '14186283',
      protectedBranch: 'main',
    });
    expect(result.verdict).toBe('success');
  });

  it('does not report a push to another branch as a boundary violation', () => {
    // Measured 2026-11-10: the check was called "no script pushes HEAD to
    // main" but counted every push, so a script that publishes through a
    // branch and a pull request — exactly what the ruleset wants — was
    // reported as a hole. The operator would learn to ignore the check.
    const result = checkBranchBoundary({
      measured: true,
      pushers: [{ file: 'crons/tuesday-code.sh', line: 178, target: 'chore/priorities-weekly' }],
      rulesetHasRequiredPr: false,
      rulesetId: '14186283',
      protectedBranch: 'main',
    });
    expect(result.verdict).toBe('success');
    // The push is still reported, so the reader can see where it went.
    expect(result.details.join(' ')).toContain('chore/priorities-weekly');
    expect(result.details.join(' ')).toContain('not the protected branch');
  });

  it('reports every push when the protected branch could not be read', () => {
    // An unknown boundary is not a boundary that can be assumed away.
    const result = checkBranchBoundary({
      measured: true,
      pushers: [{ file: 'crons/tuesday-code.sh', line: 178, target: 'chore/whatever' }],
      rulesetHasRequiredPr: null,
      rulesetId: null,
      protectedBranch: null,
    });
    expect(result.verdict).toBe('failure');
  });

  it('says unknown when there was no repository to read', () => {
    const result = checkBranchBoundary({
      measured: false,
      pushers: [],
      rulesetHasRequiredPr: null,
      rulesetId: null,
      protectedBranch: null,
    });
    expect(result.verdict).toBe('unknown');
  });
});

describe('runtime audit · gate coverage (H7)', () => {
  it('fails when a gate cannot fail on this host', () => {
    const result = checkGateCoverage({
      measured: true,
      misScoped: [{ gate: 'chain-invariant', scope: 'scans the fixture' }],
    });
    expect(result.verdict).toBe('failure');
    expect(result.summary).toContain('1 gate(s)');
  });

  it('passes when every gate can fail', () => {
    expect(checkGateCoverage({ measured: true, misScoped: [] }).verdict).toBe('success');
  });

  it('says unknown when the gate files could not be read', () => {
    expect(checkGateCoverage({ measured: false, misScoped: [] }).verdict).toBe('unknown');
  });
});

describe('runtime audit · postmortem status (H8)', () => {
  it('fails when no postmortem carries a status a tool can read', () => {
    const result = checkPostmortemStatus({ total: 11, indexed: 3, machineReadable: 0 });
    expect(result.verdict).toBe('failure');
    expect(result.summary).toContain('machine-readable status=0/11');
  });

  it('passes when the whole corpus is machine-readable', () => {
    expect(checkPostmortemStatus({ total: 11, indexed: 11, machineReadable: 11 }).verdict).toBe(
      'success',
    );
  });

  it('says unknown when there are no postmortems', () => {
    expect(checkPostmortemStatus({ total: 0, indexed: 0, machineReadable: 0 }).verdict).toBe(
      'unknown',
    );
  });
});

describe('runtime audit · end to end against an isolated home', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'memphis-audit-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('measures every hole, and says unknown for what it cannot reach', async () => {
    const report = await runRuntimeAudit({
      rawEnv: {
        ...process.env,
        MEMPHIS_DATA_DIR: home,
        DATABASE_URL: `file:${path.join(home, 'audit.db')}`,
      },
      repoRoot: null,
      config: null,
    });

    expect(report.checks.map((check) => check.id)).toEqual([...AUDIT_CHECK_IDS]);

    // No repository and no config in this home: those checks must say
    // unknown, never success.
    const byId = new Map(report.checks.map((check) => [check.id, check]));
    expect(byId.get('deployment-freshness')?.verdict).toBe('unknown');
    expect(byId.get('branch-boundary')?.verdict).toBe('unknown');
    expect(byId.get('gate-coverage')?.verdict).toBe('unknown');
    expect(byId.get('postmortem-status')?.verdict).toBe('unknown');
    expect(byId.get('chain-registry')?.verdict).toBe('unknown');
    expect(byId.get('block-vocabulary')?.verdict).toBe('unknown');

    // The health check CAN be measured here, and it moves with the host:
    // the isolated home's top line already says the system is not well,
    // so nothing is hidden below it and the check passes. On the live
    // host the same check fails — that is the mutation property.
    expect(byId.get('health-reporting')?.verdict).toBe('success');

    // The report is not "ok" — an empty host is not a healthy host.
    expect(report.ok).toBe(false);
  });

  it('renders one line per check plus the overall verdict', async () => {
    const report = await runRuntimeAudit({
      rawEnv: { ...process.env, MEMPHIS_DATA_DIR: home },
      repoRoot: null,
      config: null,
    });
    const rendered = renderAuditReport(report);
    for (const id of AUDIT_CHECK_IDS) {
      expect(rendered).toContain(id);
    }
    expect(rendered).toContain('overall:');
  });

  it('evaluates telemetry from the requested runtime directory', async () => {
    const telemetry = path.join(home, 'telemetry');
    await mkdir(telemetry);
    const now = new Date();
    const spans = ['turn.dispatch', 'provider.completion', 'tool.call'].flatMap((name) =>
      Array.from({ length: 10 }, (_, i) => ({
        ts: new Date(now.getTime() - i * 1000).toISOString(),
        name,
        status: 'ok',
        durationMs: 100,
      })),
    );
    await writeFile(
      path.join(telemetry, `spans-${now.toISOString().slice(0, 10)}.jsonl`),
      `${spans.map((span) => JSON.stringify(span)).join('\n')}\n`,
    );
    const report = await runRuntimeAudit({
      rawEnv: { ...process.env, MEMPHIS_DATA_DIR: home },
      repoRoot: null,
      config: null,
    });
    expect(report.checks.find((check) => check.id === 'slo-reporting')?.summary).toContain(
      '0 of 4 metrics unavailable; verdict=passing',
    );
  });
});

describe('runtime audit · the mutation property', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'memphis-audit-mutation-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const writeBlock = async (type: string): Promise<void> => {
    const dir = path.join(home, 'chains', 'journal');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, '000001.json'),
      JSON.stringify({
        index: 1,
        timestamp: new Date().toISOString(),
        chain: 'journal',
        data: { type, content: 'probe', tags: [] },
        prev_hash: '0'.repeat(64),
        hash: '0'.repeat(64),
      }),
      'utf8',
    );
  };

  it('changes its verdict when the system changes', async () => {
    const rawEnv = { ...process.env, MEMPHIS_DATA_DIR: home };

    // A live chain whose blocks the core can read: the check passes.
    await writeBlock('journal');
    const healthy = await runRuntimeAudit({ rawEnv, repoRoot: null, config: null });
    expect(healthy.checks.find((check) => check.id === 'block-vocabulary')?.verdict).toBe(
      'success',
    );

    // The same chain, one block the core cannot deserialize: the check
    // fails, and it names the block. This is the mutation: the audit's
    // answer moves with the system it measures.
    await writeBlock('autonom_publication');
    const broken = await runRuntimeAudit({ rawEnv, repoRoot: null, config: null });
    const vocabulary = broken.checks.find((check) => check.id === 'block-vocabulary');
    expect(vocabulary?.verdict).toBe('failure');
    expect(vocabulary?.summary).toContain('1 of 1');
    expect(vocabulary?.details.join(' ')).toContain('autonom_publication');
  });
});

describe('runtime audit · the freshness window carries its timezone', () => {
  const execFileAsync = promisify(execFile);
  let home: string;
  let repo: string;
  const originalTz = process.env.TZ;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'memphis-freshness-'));
    repo = path.join(home, 'repo');
    await mkdir(repo, { recursive: true });
    // CET: one hour ahead of UTC in November. The bug only shows in a
    // zone that is not UTC, so the test pins one.
    process.env.TZ = 'Europe/Warsaw';
  });

  afterEach(async () => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
    await rm(home, { recursive: true, force: true });
  });

  /** A repository whose single commit carries the given date. */
  const commitAt = async (iso: string): Promise<void> => {
    const env = {
      ...process.env,
      GIT_AUTHOR_DATE: iso,
      GIT_COMMITTER_DATE: iso,
    };
    await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.email', 'audit@memphis.local'], { cwd: repo });
    await execFileAsync('git', ['config', 'user.name', 'audit'], { cwd: repo });
    await execFileAsync('git', ['commit', '-q', '--allow-empty', '-m', 'merge'], {
      cwd: repo,
      env,
    });
  };

  /** A dist/ whose newest file carries the given mtime. */
  const buildAt = async (iso: string): Promise<void> => {
    const dist = path.join(repo, 'dist');
    await mkdir(dist, { recursive: true });
    const file = path.join(dist, 'index.js');
    await writeFile(file, '// build\n', 'utf8');
    const seconds = Date.parse(iso) / 1000;
    await utimes(file, seconds, seconds);
  };

  const commitsBehind = async (): Promise<string> => {
    const report = await runRuntimeAudit({
      rawEnv: { ...process.env, MEMPHIS_DATA_DIR: home },
      repoRoot: repo,
      config: null,
    });
    const check = report.checks.find((entry) => entry.id === 'deployment-freshness');
    return check?.summary ?? '';
  };

  it('does not count a commit that landed before the build', async () => {
    // The commit is 61 seconds OLDER than the build, one hour apart in
    // wall-clock terms from the naive stamp the old code produced.
    await commitAt('2026-11-04T10:38:00Z');
    await buildAt('2026-11-04T10:39:01Z');

    expect(await commitsBehind()).toContain('0 commit(s) behind');
  });

  it('counts a commit that landed after the build', async () => {
    // The mirror image: the commit is NEWER than the build, so the
    // check has to fail — otherwise the fix would have broken the thing
    // the check exists for.
    await commitAt('2026-11-04T10:40:00Z');
    await buildAt('2026-11-04T10:39:01Z');

    expect(await commitsBehind()).toContain('1 commit(s) behind');
  });
});
