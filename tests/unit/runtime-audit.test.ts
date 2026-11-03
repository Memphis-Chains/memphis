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

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
    catalogNames: ['journal', 'decisions'],
    codeAllowlist: ['journal', 'decisions'],
    effectiveAllowlist: ['journal', 'decisions'],
    configAllowlist: ['journal', 'decisions'],
    diskDirs: ['journal', 'decisions'],
    scannableDirs: ['journal', 'decisions'],
  };

  it('passes when the four lists agree', () => {
    expect(checkChainRegistry(clean).verdict).toBe('success');
  });

  it('fails on a name the taxonomy has and nothing else does', () => {
    const result = checkChainRegistry({
      ...clean,
      catalogNames: ['journal', 'decisions', 'proactive'],
    });
    expect(result.verdict).toBe('failure');
    expect(result.summary).toContain('proactive');
  });

  it('fails on a directory nothing scans', () => {
    const result = checkChainRegistry({ ...clean, diskDirs: [...clean.diskDirs, '_quarantine'] });
    expect(result.verdict).toBe('failure');
    expect(result.details.join(' ')).toContain('_quarantine');
  });

  it('fails on an allowlisted chain the scanner cannot open', () => {
    const result = checkChainRegistry({
      ...clean,
      effectiveAllowlist: [...clean.effectiveAllowlist, 'journal.backup-1'],
      diskDirs: [...clean.diskDirs, 'journal.backup-1'],
      scannableDirs: [...clean.scannableDirs],
    });
    expect(result.verdict).toBe('failure');
    expect(result.details.join(' ')).toContain('journal.backup-1');
  });

  it('fails when the live config overrides the code silently', () => {
    const result = checkChainRegistry({ ...clean, configAllowlist: ['journal'] });
    expect(result.verdict).toBe('failure');
    expect(result.details.join(' ')).toContain('differs from the code default');
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
    });
    expect(result.verdict).toBe('success');
  });

  it('says unknown when there was no repository to read', () => {
    const result = checkBranchBoundary({
      measured: false,
      pushers: [],
      rulesetHasRequiredPr: null,
      rulesetId: null,
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
