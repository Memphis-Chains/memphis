import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

describe('guard failure drill script', () => {
  it('reports expected outcomes for trust-root and revocation drills', () => {
    const result = spawnSync('npm', ['run', '-s', 'ops:drill-guards'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[PASS] trust-root-invalid-strict');
    expect(result.stdout).toContain(`exitCode=103`);
    expect(result.stdout).toContain('[PASS] revocation-stale');
    expect(result.stdout).toContain('stale=true');
  });

  it('supports json output mode for ops automation', () => {
    const result = spawnSync('npm', ['run', '-s', 'ops:drill-guards', '--', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      schemaVersion: number;
      ok: boolean;
      scenarios: Array<{ name: string; ok: boolean; detail: string }>;
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.ok).toBe(true);
    expect(parsed.scenarios.map((entry) => entry.name).sort()).toEqual([
      'revocation-stale',
      'trust-root-invalid-strict',
    ]);
    expect(parsed.scenarios.every((entry) => entry.ok)).toBe(true);
  });
});
