import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type OutputContract = {
  schemaVersion: number;
  summaryTopLevelKeys: string[];
  gateTopLevelKeys: string[];
};

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const outputContractPath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'release-draft',
  'release-preflight-output-contract.json',
);

function runReleasePreflight(
  overrideGates: Array<{ id: string; command: string; args: string[] }>,
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
): ReturnType<typeof spawnSync> {
  return spawnSync('npm', ['run', '-s', 'ops:release-preflight', '--', ...extraArgs], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      MEMPHIS_RELEASE_PREFLIGHT_GATE_OVERRIDE_JSON: JSON.stringify(overrideGates),
      MEMPHIS_RELEASE_PREFLIGHT_ALLOW_TEST_OVERRIDE: '1',
      ...extraEnv,
    },
  });
}

describe('ops:release-preflight', () => {
  it('passes when all gates succeed', () => {
    const result = runReleasePreflight([
      { id: 'ok-a', command: 'node', args: ['-e', 'process.exit(0)'] },
      { id: 'ok-b', command: 'node', args: ['-e', 'process.exit(0)'] },
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[PASS] release preflight gates passed');
  });

  it('fails fast on first failing gate', () => {
    const result = runReleasePreflight([
      { id: 'ok-a', command: 'node', args: ['-e', 'process.exit(0)'] },
      { id: 'fail-b', command: 'node', args: ['-e', 'process.exit(7)'] },
      { id: 'never-run', command: 'node', args: ['-e', 'process.exit(0)'] },
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('[FAIL] fail-b failed with exit code 7');
    expect(result.stdout).not.toContain('never-run');
  });

  it('emits stable machine-readable output contract in --json mode', () => {
    const result = runReleasePreflight(
      [
        { id: 'ok-a', command: 'node', args: ['-e', 'process.exit(0)'] },
        { id: 'ok-b', command: 'node', args: ['-e', 'process.exit(0)'] },
      ],
      ['--json'],
    );
    const contract = JSON.parse(readFileSync(outputContractPath, 'utf8')) as OutputContract;

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      schemaVersion: number;
      ok: boolean;
      startedAt: string;
      completedAt: string;
      gates: Array<{
        id: string;
        command: string;
        ok: boolean;
        exitCode: number;
        durationMs: number;
        error: string | null;
      }>;
      error: string | null;
    };

    expect(parsed.schemaVersion).toBe(contract.schemaVersion);
    expect(Object.keys(parsed).sort()).toEqual([...contract.summaryTopLevelKeys].sort());
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    expect(parsed.gates.length).toBe(2);
    for (const gate of parsed.gates) {
      expect(Object.keys(gate).sort()).toEqual([...contract.gateTopLevelKeys].sort());
      expect(gate.ok).toBe(true);
      expect(gate.error).toBeNull();
    }
  });

  it('fails closed when override env is set without explicit test-only mode', () => {
    const result = spawnSync('npm', ['run', '-s', 'ops:release-preflight', '--', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        MEMPHIS_RELEASE_PREFLIGHT_GATE_OVERRIDE_JSON: JSON.stringify([
          { id: 'lint', command: 'node', args: ['-e', 'process.exit(0)'] },
        ]),
      },
    });

    expect(result.status).toBe(2);
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      gates: unknown[];
      error: string | null;
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.gates).toEqual([]);
    expect(parsed.error).toBe(
      'MEMPHIS_RELEASE_PREFLIGHT_GATE_OVERRIDE_JSON requires MEMPHIS_RELEASE_PREFLIGHT_ALLOW_TEST_OVERRIDE=1',
    );
  });
});
