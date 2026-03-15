import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  checkIds: string[];
};

function parseGithubOutput(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = line.slice(0, separatorIndex);
    const value = line.slice(separatorIndex + 1);
    result[key] = value;
  }
  return result;
}

describe('strict-handoff validator JSON gate helper script', () => {
  it('passes in default local-shell mode without GITHUB_OUTPUT emission', () => {
    const result = spawnSync('bash', ['./scripts/strict-handoff-validator-json-gate.sh'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: process.env,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"ok": true');
  });

  it('writes stable check-order outputs when GITHUB_OUTPUT emission is enabled', () => {
    const outputDir = mkdtempSync(path.join(tmpdir(), 'memphis-gate-output-'));
    const githubOutputPath = path.join(outputDir, 'github-output.txt');
    writeFileSync(githubOutputPath, '', 'utf8');

    const result = spawnSync('bash', ['./scripts/strict-handoff-validator-json-gate.sh'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        ...process.env,
        MEMPHIS_STRICT_HANDOFF_GATE_OUTPUT: '1',
        GITHUB_OUTPUT: githubOutputPath,
      },
    });

    expect(result.status).toBe(0);
    const contract = JSON.parse(
      readFileSync(validatorOutputContractPath, 'utf8'),
    ) as ValidatorOutputContract;
    const output = parseGithubOutput(readFileSync(githubOutputPath, 'utf8'));

    expect(output.check_order_status).toBe('matched');
    expect(output.check_ids).toBe(JSON.stringify(contract.checkIds));
  });

  it('fails closed when output emission is requested without GITHUB_OUTPUT', () => {
    const env = { ...process.env, MEMPHIS_STRICT_HANDOFF_GATE_OUTPUT: '1' };
    delete env.GITHUB_OUTPUT;

    const result = spawnSync('bash', ['./scripts/strict-handoff-validator-json-gate.sh'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env,
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('"ok": true');
    expect(`${result.stdout}${result.stderr}`).toContain(
      'MEMPHIS_STRICT_HANDOFF_GATE_OUTPUT=1 requires GITHUB_OUTPUT',
    );
  });
});
