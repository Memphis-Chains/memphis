import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const bashPath = resolveCommand('bash');

function resolveCommand(command: string): string {
  const result = spawnSync('bash', ['-lc', `command -v ${command}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Unable to resolve command on PATH: ${command}`);
  }
  return result.stdout.trim();
}

describe('scripts/install.sh --check-only --json', () => {
  it('emits a stable source-checkout support contract without mutating the host', () => {
    const result = spawnSync(bashPath, ['./scripts/install.sh', '--check-only', '--json'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 120_000,
    });

    if (result.error) {
      throw result.error;
    }

    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe('');

    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      mode: string;
      platform: string;
      repoMode: string;
      targetDir: string;
      nodeVersion: string;
      rustVersion: string;
      supportedNodeMajor: number;
      primaryOperatorPath: string;
    };

    expect(parsed.ok).toBe(true);
    expect(parsed.mode).toBe('check-only');
    expect(parsed.primaryOperatorPath).toBe('source-checkout');
    expect(parsed.supportedNodeMajor).toBe(22);
    expect(parsed.repoMode).toBe('source-checkout');
    expect(parsed.targetDir).toBe(repoRoot);
    expect(parsed.platform.length).toBeGreaterThan(0);
    expect(parsed.nodeVersion.startsWith('v')).toBe(true);
    expect(parsed.rustVersion).toContain('rustc');
  });

  it('accepts python3 as the downloader fallback when curl is unavailable', () => {
    const tempBin = mkdtempSync(path.join(tmpdir(), 'memphis-install-path-'));

    try {
      for (const command of [
        'awk',
        'cargo',
        'dirname',
        'git',
        'grep',
        'node',
        'npm',
        'python3',
        'rustc',
        'uname',
      ]) {
        symlinkSync(resolveCommand(command), path.join(tempBin, command));
      }

      const result = spawnSync(bashPath, ['./scripts/install.sh', '--check-only', '--json'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 120_000,
        env: {
          ...process.env,
          PATH: tempBin,
        },
      });

      if (result.error) {
        throw result.error;
      }

      expect(result.status).toBe(0);
      expect(result.stderr.trim()).toBe('');
      const parsed = JSON.parse(result.stdout) as { ok: boolean; mode: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.mode).toBe('check-only');
    } finally {
      rmSync(tempBin, { recursive: true, force: true });
    }
  });
});
