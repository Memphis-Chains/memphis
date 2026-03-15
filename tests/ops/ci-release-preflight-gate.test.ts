import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const strictValidatorOutputContractPath = path.resolve(
  repoRoot,
  'tests',
  'fixtures',
  'strict-handoff',
  'validator-output-contract.json',
);
const releaseGateOutputContractPath = path.resolve(
  repoRoot,
  'tests',
  'fixtures',
  'release-draft',
  'ci-release-preflight-gate-output-contract.json',
);

type GateOverride = { id: string; command: string; args: string[] };
type StrictValidatorOutputContract = { checkIds: string[] };
type ReleaseGateOutputContract = {
  requiredOutputKeys: string[];
  strictGateIds: string[];
  strictCheckOrderStatus: string;
};

const testOverrideEnv = {
  MEMPHIS_RELEASE_PREFLIGHT_ALLOW_TEST_OVERRIDE: '1',
} as const;
const overrideAllowError =
  'MEMPHIS_RELEASE_PREFLIGHT_GATE_OVERRIDE_JSON requires MEMPHIS_RELEASE_PREFLIGHT_ALLOW_TEST_OVERRIDE=1';

function runCiPreflightGateWithOverride(
  overrideGatesRaw: string,
  sha: string,
  extraEnv: Record<string, string> = {},
): { result: ReturnType<typeof spawnSync>; stepSummaryPath: string; githubOutputPath: string } {
  const outDir = mkdtempSync(path.join(tmpdir(), 'memphis-ci-preflight-gate-'));
  const stepSummaryPath = path.join(outDir, 'step-summary.md');
  const githubOutputPath = path.join(outDir, 'github-output.txt');
  writeFileSync(stepSummaryPath, '', 'utf8');
  writeFileSync(githubOutputPath, '', 'utf8');

  const childEnv = { ...process.env };
  delete childEnv.MEMPHIS_RELEASE_PREFLIGHT_GATE_OVERRIDE_JSON;
  delete childEnv.MEMPHIS_RELEASE_PREFLIGHT_ALLOW_TEST_OVERRIDE;
  delete childEnv.MEMPHIS_RELEASE_PREFLIGHT_GATE_OUTPUT;
  delete childEnv.MEMPHIS_STRICT_HANDOFF_GATE_OUTPUT;

  const result = spawnSync('bash', ['./scripts/ci-release-preflight-gate.sh'], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...childEnv,
      MEMPHIS_RELEASE_PREFLIGHT_GATE_OVERRIDE_JSON: overrideGatesRaw,
      RUNNER_TEMP: outDir,
      GITHUB_STEP_SUMMARY: stepSummaryPath,
      GITHUB_OUTPUT: githubOutputPath,
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'Memphis-Chains/MemphisOS',
      GITHUB_SHA: sha,
      ...extraEnv,
    },
  });

  return { result, stepSummaryPath, githubOutputPath };
}

function parseGithubOutput(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;

    const heredocIndex = line.indexOf('<<');
    if (heredocIndex > 0) {
      const key = line.slice(0, heredocIndex);
      const terminator = line.slice(heredocIndex + 2);
      const chunks: string[] = [];
      index += 1;
      while (index < lines.length && lines[index] !== terminator) {
        chunks.push(lines[index]);
        index += 1;
      }
      result[key] = chunks.join('\n');
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex > 0) {
      result[line.slice(0, separatorIndex)] = line.slice(separatorIndex + 1);
    }
  }
  return result;
}

describe('ci release-preflight gate helper script', () => {
  it('fails closed when override env is set without explicit test-only mode', () => {
    const override: GateOverride[] = [
      { id: 'typecheck', command: 'node', args: ['-e', 'process.exit(0)'] },
    ];
    const { result, stepSummaryPath, githubOutputPath } = runCiPreflightGateWithOverride(
      JSON.stringify(override),
      'forced-sha-0',
    );

    expect(result.status).toBe(2);
    const expectedUrl =
      'https://github.com/Memphis-Chains/MemphisOS/blob/forced-sha-0/docs/runbooks/RELEASE.md#ci-preflight-failure-triage-map';
    const combinedOutput = `${result.stdout}${result.stderr}`;
    const stepSummary = readFileSync(stepSummaryPath, 'utf8');
    const githubOutput = readFileSync(githubOutputPath, 'utf8');

    expect(combinedOutput).toContain(overrideAllowError);
    expect(combinedOutput).toContain('::error::release preflight emitted empty gates list');
    expect(combinedOutput).toContain(
      `::error::Release preflight failed. Remediation: ${expectedUrl}`,
    );
    expect(stepSummary).toContain(overrideAllowError);
    expect(stepSummary).toContain('- `(none)`');
    expect(stepSummary).toContain(`- [${expectedUrl}](${expectedUrl})`);
    expect(githubOutput).toBe('');
  });

  it('emits failing-gate remediation URL for forced gate failures', () => {
    const override: GateOverride[] = [
      { id: 'lint', command: 'node', args: ['-e', 'process.exit(0)'] },
      { id: 'typecheck', command: 'node', args: ['-e', 'process.exit(9)'] },
    ];
    const { result, stepSummaryPath } = runCiPreflightGateWithOverride(
      JSON.stringify(override),
      'forced-sha-1',
      testOverrideEnv,
    );

    expect(result.status).not.toBe(0);
    const expectedUrl =
      'https://github.com/Memphis-Chains/MemphisOS/blob/forced-sha-1/docs/runbooks/RELEASE.md#ci-preflight-gate-typecheck';
    const combinedOutput = `${result.stdout}${result.stderr}`;
    const stepSummary = readFileSync(stepSummaryPath, 'utf8');

    expect(combinedOutput).toContain(
      `::error::Release preflight failed. Remediation: ${expectedUrl}`,
    );
    expect(stepSummary).toContain(`- [${expectedUrl}](${expectedUrl})`);
  });

  it('falls back to triage-map remediation URL when failed gate id is unavailable', () => {
    const { result, stepSummaryPath } = runCiPreflightGateWithOverride(
      '[]',
      'forced-sha-2',
      testOverrideEnv,
    );

    expect(result.status).not.toBe(0);
    const expectedUrl =
      'https://github.com/Memphis-Chains/MemphisOS/blob/forced-sha-2/docs/runbooks/RELEASE.md#ci-preflight-failure-triage-map';
    const combinedOutput = `${result.stdout}${result.stderr}`;
    const stepSummary = readFileSync(stepSummaryPath, 'utf8');

    expect(combinedOutput).toContain('::error::release preflight emitted empty gates list');
    expect(combinedOutput).toContain(
      `::error::Release preflight failed. Remediation: ${expectedUrl}`,
    );
    expect(stepSummary).toContain(`- [${expectedUrl}](${expectedUrl})`);
  });

  it('emits release-preflight outputs when output mode is enabled', () => {
    const override: GateOverride[] = [
      { id: 'lint', command: 'node', args: ['-e', 'process.exit(0)'] },
      { id: 'typecheck', command: 'node', args: ['-e', 'process.exit(0)'] },
    ];
    const { result, githubOutputPath } = runCiPreflightGateWithOverride(
      JSON.stringify(override),
      'forced-sha-3',
      {
        ...testOverrideEnv,
        MEMPHIS_RELEASE_PREFLIGHT_GATE_OUTPUT: '1',
      },
    );

    expect(result.status).toBe(0);
    const output = parseGithubOutput(readFileSync(githubOutputPath, 'utf8'));

    expect(output.preflight_gate_ids).toBe('["lint","typecheck"]');
    expect(output.preflight_summary_json).toContain('"schemaVersion": 1');
    expect(output.preflight_summary_json).toContain('"ok": true');
  });

  it('fails closed when strict output mode is enabled but strict gate outputs are missing', () => {
    const override: GateOverride[] = [
      { id: 'lint', command: 'node', args: ['-e', 'process.exit(0)'] },
      { id: 'typecheck', command: 'node', args: ['-e', 'process.exit(0)'] },
    ];
    const { result } = runCiPreflightGateWithOverride(JSON.stringify(override), 'forced-sha-4', {
      ...testOverrideEnv,
      MEMPHIS_RELEASE_PREFLIGHT_GATE_OUTPUT: '1',
      MEMPHIS_STRICT_HANDOFF_GATE_OUTPUT: '1',
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      'strict-handoff gate outputs were not emitted by ops:release-preflight',
    );
  });

  it('emits stable strict output keys in release-output mode when strict gate runs', () => {
    const override: GateOverride[] = [
      {
        id: 'strictHandoffJsonGate',
        command: 'bash',
        args: ['./scripts/strict-handoff-validator-json-gate.sh'],
      },
    ];
    const { result, githubOutputPath } = runCiPreflightGateWithOverride(
      JSON.stringify(override),
      'forced-sha-5',
      {
        ...testOverrideEnv,
        MEMPHIS_RELEASE_PREFLIGHT_GATE_OUTPUT: '1',
        MEMPHIS_STRICT_HANDOFF_GATE_OUTPUT: '1',
      },
    );

    expect(result.status).toBe(0);
    const output = parseGithubOutput(readFileSync(githubOutputPath, 'utf8'));
    const strictValidatorContract = JSON.parse(
      readFileSync(strictValidatorOutputContractPath, 'utf8'),
    ) as StrictValidatorOutputContract;
    const releaseGateContract = JSON.parse(
      readFileSync(releaseGateOutputContractPath, 'utf8'),
    ) as ReleaseGateOutputContract;

    for (const key of releaseGateContract.requiredOutputKeys) {
      expect(Object.prototype.hasOwnProperty.call(output, key)).toBe(true);
    }
    expect(output.preflight_gate_ids).toBe(JSON.stringify(releaseGateContract.strictGateIds));
    expect(output.check_order_status).toBe(releaseGateContract.strictCheckOrderStatus);
    expect(output.check_ids).toBe(JSON.stringify(strictValidatorContract.checkIds));

    const summary = JSON.parse(output.preflight_summary_json) as {
      ok: boolean;
      gates: Array<{ id: string }>;
    };
    expect(summary.ok).toBe(true);
    expect(summary.gates.map((gate) => gate.id)).toEqual(releaseGateContract.strictGateIds);
  });
});
