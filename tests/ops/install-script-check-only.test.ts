import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

describe('scripts/install.sh --check-only --json', () => {
  it('emits a stable source-checkout support contract without mutating the host', () => {
    const result = spawnSync('bash', ['./scripts/install.sh', '--check-only', '--json'], {
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
});
