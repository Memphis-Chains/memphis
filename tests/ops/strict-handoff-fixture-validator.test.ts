import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const validatorOutputContractPath = path.resolve(
  repoRoot,
  'tests',
  'fixtures',
  'strict-handoff',
  'validator-output-contract.json',
);

type ValidatorOutputContract = {
  schemaVersion: number;
  summaryTopLevelKeys: string[];
  checkTopLevelKeys: string[];
  checkIds: string[];
};

const validatorOutputContract = JSON.parse(
  readFileSync(validatorOutputContractPath, 'utf8'),
) as ValidatorOutputContract;

describe('strict-handoff fixture validation script', () => {
  it('validates fixtures and live command outputs against strict-handoff schemas', () => {
    const result = spawnSync('npm', ['run', '-s', 'ops:validate-strict-handoff-fixtures'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: process.env,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[PASS] summary example fixture matches summary schema');
    expect(result.stdout).toContain(
      '[PASS] completion-hints example fixture matches completion-hints schema',
    );
    expect(result.stdout).toContain(
      '[PASS] completion-hints command output matches completion-hints schema',
    );
    expect(result.stdout).toContain('[PASS] summary command output matches summary schema');
    expect(result.stdout).toContain('[PASS] strict-handoff fixture/schema validation completed');
  });

  it('emits machine-readable summary with stable key and check contracts in --json mode', () => {
    const result = spawnSync(
      'npm',
      ['run', '-s', 'ops:validate-strict-handoff-fixtures', '--', '--json'],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 60_000,
        env: process.env,
      },
    );

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      schemaVersion: number;
      ok: boolean;
      checks: Array<{ id: string; ok: boolean; error: string | null }>;
      error: string | null;
      errors: string[];
    };

    expect(parsed.schemaVersion).toBe(validatorOutputContract.schemaVersion);
    expect(Object.keys(parsed).sort()).toEqual(
      [...validatorOutputContract.summaryTopLevelKeys].sort(),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.error).toBeNull();
    expect(parsed.errors).toEqual([]);

    expect(parsed.checks.map((entry) => entry.id)).toEqual(validatorOutputContract.checkIds);
    for (const entry of parsed.checks) {
      expect(Object.keys(entry).sort()).toEqual(
        [...validatorOutputContract.checkTopLevelKeys].sort(),
      );
      expect(entry.ok).toBe(true);
      expect(entry.error).toBeNull();
    }
  });
});
