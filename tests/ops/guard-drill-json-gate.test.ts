import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('guard drill JSON gate script', () => {
  it('passes with the live guard drill output', () => {
    const result = spawnSync('bash', ['./scripts/guard-drill-json-gate.sh'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
      env: process.env,
    });

    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      schemaVersion: number;
      ok: boolean;
      scenarios: Array<{ name: string }>;
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.ok).toBe(true);
    expect(parsed.scenarios.map((scenario) => scenario.name).sort()).toEqual([
      'revocation-stale',
      'trust-root-invalid-strict',
    ]);
  });

  it('fails closed when required guard drill scenarios are missing', () => {
    const fakeBinDir = mkdtempSync(path.join(tmpdir(), 'memphis-guard-drill-gate-'));
    tempDirs.push(fakeBinDir);
    const fakeNpmPath = path.join(fakeBinDir, 'npm');
    writeFileSync(
      fakeNpmPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'printf \'%s\\n\' \'{"schemaVersion":1,"ok":true,"scenarios":[{"name":"trust-root-invalid-strict","ok":true,"detail":"stub"}]}\'',
      ].join('\n'),
      'utf8',
    );
    chmodSync(fakeNpmPath, 0o755);

    const result = spawnSync('bash', ['./scripts/guard-drill-json-gate.sh'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
      env: {
        ...process.env,
        PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      },
    });

    expect(result.status).not.toBe(0);
    const combinedOutput = `${result.stdout}${result.stderr}`;
    expect(combinedOutput).toContain('"trust-root-invalid-strict"');
    expect(combinedOutput).not.toContain('"revocation-stale"');
  });
});
