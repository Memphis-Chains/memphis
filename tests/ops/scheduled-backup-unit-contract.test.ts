import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The nightly backup unit, as shipped.
 *
 * Two defects, both measured on this host:
 *
 *  1. It was not in the repository at all. `scripts/systemd/` carries every
 *     other managed unit, but not this one, so no installer deployed it and no
 *     test could see it — while it was the only thing actually taking a daily
 *     backup. The file existed only under `~/.config/systemd/user/`, which is
 *     exactly the shape that lets a fix stay fixed for nobody.
 *
 *  2. The copy on disk ran without `--data-dir`, and the runner refuses to
 *     start without it. That guard is deliberate — importing the module once
 *     deleted an operator archive through the keep=7 retention — so the unit
 *     has to carry the flag rather than the guard being removed. The first
 *     nightly run after the guard landed failed with exit 2 and produced no
 *     archive at all (2026-10-12 04:00).
 */

const UNIT = join(process.cwd(), 'scripts/systemd/memphis-scheduled-backup.service');
const RUNNER = join(process.cwd(), 'scripts/scheduled-backup-runner.mjs');

function unitSource(): string {
  return readFileSync(UNIT, 'utf8');
}

/** The ExecStart line, comments stripped so documentation cannot satisfy it. */
function execStartLines(): string[] {
  return unitSource()
    .split('\n')
    .filter((line) => !/^\s*[#;]/.test(line))
    .filter((line) => /^\s*ExecStart=/.test(line))
    .map((line) => line.replace(/^\s*ExecStart=/, '').trim());
}

describe('scripts/systemd/memphis-scheduled-backup.service', () => {
  it('exists in the repository, not only under ~/.config/systemd/user', () => {
    // The whole reason this contract exists: the unit was live on this host
    // and absent from the repo, so no installer shipped it and no test could
    // fail when it drifted.
    expect(unitSource()).toContain('scripts/scheduled-backup-runner.mjs');
  });

  it('passes --data-dir, which the runner requires to run at all', () => {
    // Asserted against the runner's own guard, not a copy of the message: if
    // the guard ever changes, this test changes with it or fails.
    const runner = readFileSync(RUNNER, 'utf8');
    expect(runner).toMatch(/refusing to run without an explicit --data-dir/);

    const lines = execStartLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(/--data-dir/);
      // `%h` is systemd's home specifier, so the unit works for any operator
      // rather than for the path this host happens to use.
      expect(line).toMatch(/--data-dir\s+%h\/\.memphis\b/);
    }
  });

  it("parses as a valid unit (syntax, not this host's filesystem)", () => {
    const result = spawnSync('systemd-analyze', ['verify', UNIT], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    // Only complaints that make the file WRONG count. What the host has
    // installed is a separate question — on a GitHub runner /usr/bin/node
    // lives under /opt/hostedtoolcache and `%h` has no user manager context,
    // so both are reported while the unit is valid. Measured: this assertion
    // failed CI for exactly that reason, the same way
    // managed-app-units-contract.test.ts had to learn it before.
    //
    // `Unknown key … ignoring.` is NOT in that set: systemd ignores the key
    // and carries on, so it is a warning about a typo rather than a broken
    // file, and treating it as fatal makes the assertion fail on a unit that
    // still loads. Checked by mutation — a unit with a bogus directive and a
    // misplaced StartLimitIntervalSec is what must fail.
    const fatal = (result.stderr ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('memphis-scheduled-backup'))
      .filter(
        (line) =>
          !/is not executable|not found|No such file or directory|Unknown key|ignoring\.$/i.test(
            line,
          ),
      );
    expect(fatal).toEqual([]);
  }, 30_000);

  it('the runner it points at starts and refuses nothing it needs', () => {
    expect(readFileSync(RUNNER, 'utf8')).toContain('--data-dir');
    // `--dry-run` is the only invocation that writes nothing, so it is the one
    // a test may make. Against an EMPTY directory: --data-dir $TMPDIR walks
    // every file under /tmp, which is tens of thousands here and ran past a
    // 30 s timeout — a test that hangs tells you nothing about the contract.
    const emptyRoot = mkdtempSync(join(tmpdir(), 'memphis-backup-unit-'));
    try {
      const probe = execFileSync('node', [RUNNER, '--dry-run', '--data-dir', emptyRoot], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      });
      expect(JSON.parse(probe).dryRun).toBe(true);
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  }, 45_000);
});
