import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Regression test for the 2026-10-08 finding: lr-dashboard.service had
// restarted 325 times in 12 hours, each writing the same failure line to
// the journal every 5 s.
//
// Root cause: `StandardOutput=append:<path>` does not create missing parent
// directories. systemd opens stdout BEFORE ExecStart runs, so the unit died
// at step STDOUT with 209/STDOUT and never reached ExecStart at all.
//
// The fix is NOT an ExecStartPre mkdir — stdout is opened before ExecStartPre
// runs, so that mkdir dies at STDOUT too. That was measured, not guessed:
// my first attempt failed with 209/STDOUT on the mkdir process itself.
// The directory must exist before the unit is started.

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const systemdDir = path.join(repoRoot, 'scripts', 'systemd');
const installerPath = path.join(systemdDir, 'install-managed-app-units.sh');
const unitPath = path.join(systemdDir, 'lr-dashboard.service');

const unit = readFileSync(unitPath, 'utf8');
const installer = readFileSync(installerPath, 'utf8');

describe('lr-dashboard.service — log directory contract', () => {
  it('logs into apps/<name>/state under the memphis data dir', () => {
    expect(unit).toMatch(
      /StandardOutput=append:\/home\/memphis\/\.memphis\/apps\/lr-dashboard\/state\//,
    );
    expect(unit).toMatch(
      /StandardError=append:\/home\/memphis\/\.memphis\/apps\/lr-dashboard\/state\//,
    );
  });

  it('does not pretend an ExecStartPre mkdir can fix a missing log dir', () => {
    // Measured failure of that approach: the ExecStartPre process itself
    // died at step STDOUT, because stdout is opened before ExecStartPre.
    expect(unit).not.toMatch(/^ExecStartPre=.*mkdir/m);
  });

  it('caps restart storms so a structural failure stops flooding the journal', () => {
    expect(unit).toMatch(/^Restart=on-failure$/m);
    expect(unit).toMatch(/^StartLimitIntervalSec=\d+$/m);
    expect(unit).toMatch(/^StartLimitBurst=\d+$/m);
    // Exactly one RestartSec — a duplicate silently keeps the last value
    // and hides the drift.
    expect(unit.match(/^RestartSec=/gm) ?? []).toHaveLength(1);
  });

  it('keeps StartLimit directives in [Unit], where systemd reads them', () => {
    // systemd v229+ moved StartLimit* out of [Service]; in [Service] they
    // are ignored, so a unit can look like it has a limit and have none.
    const unitSection = unit.slice(0, unit.indexOf('[Service]'));
    expect(unitSection).toMatch(/^StartLimitIntervalSec=\d+$/m);
    expect(unitSection).toMatch(/^StartLimitBurst=\d+$/m);
  });

  it('parses as a valid unit', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'unit-verify-'));
    try {
      const copy = path.join(tmp, 'lr-dashboard.service');
      writeFileSync(copy, unit, 'utf8');
      const result = spawnSync('systemd-analyze', ['verify', copy], {
        encoding: 'utf8',
        timeout: 30_000,
      });
      // Only lines about this unit matter; systemd-analyze reports unrelated
      // host units on some setups.
      const noise = (result.stderr ?? '')
        .split('\n')
        .filter((line) => line.trim() && line.includes('lr-dashboard'));
      expect(noise).toEqual([]);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('scripts/systemd/install-managed-app-units.sh — creates what the unit needs', () => {
  it('exists and is referenced by the unit comment', () => {
    expect(existsSync(installerPath)).toBe(true);
    expect(unit).toContain('install-managed-app-units.sh');
  });

  it('creates the apps/<name>/state directory the unit logs into', () => {
    expect(installer).toMatch(/\$MEMPHIS_ROOT\/apps\/lr-dashboard\/state/);
    expect(installer).toMatch(/mkdir -p "\$d"/);
  });

  it('passes shell syntax validation', () => {
    const result = spawnSync('bash', ['-n', installerPath], { encoding: 'utf8', timeout: 30_000 });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('creates the state dirs for real, against a throwaway MEMPHIS_ROOT', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'managed-app-root-'));
    const unitDir = path.join(root, 'unit');
    try {
      const result = spawnSync('bash', [installerPath], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          MEMPHIS_ROOT: root,
          UNIT_DIR: unitDir,
          // Do not touch the operator's real systemd user manager.
          PATH: '/usr/bin:/bin',
        },
      });

      expect(result.stdout).toContain('state dir ready');
      expect(existsSync(path.join(root, 'apps', 'lr-dashboard', 'state'))).toBe(true);
      expect(existsSync(path.join(unitDir, 'lr-dashboard.service'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('is idempotent — a second run reports unchanged and installs nothing new', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'managed-app-idem-'));
    const unitDir = path.join(root, 'unit');
    const env = { ...process.env, MEMPHIS_ROOT: root, UNIT_DIR: unitDir, PATH: '/usr/bin:/bin' };
    try {
      const first = spawnSync('bash', [installerPath], { encoding: 'utf8', timeout: 30_000, env });
      expect(first.stdout).toContain('installed: lr-dashboard.service');

      const second = spawnSync('bash', [installerPath], { encoding: 'utf8', timeout: 30_000, env });
      expect(second.stdout).toContain('unchanged: lr-dashboard.service');
      expect(second.stdout).not.toContain('installed:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
