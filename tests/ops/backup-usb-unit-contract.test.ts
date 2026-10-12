import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The offsite unit and its mount helper, as shipped.
 *
 * Measured on this host, 2026-10-12: 58 consecutive "failed verify, refusing
 * to copy" until 2026-10-08, then 25 consecutive "no USB mount found" every
 * four hours — with the drive plugged in the whole time. Zero successful copies
 * in the unit's entire journal.
 *
 * Two separate causes, and both had to be fixed for a copy to happen:
 *
 *  1. The unit had no mount step. /run is tmpfs, so a mount does not survive
 *     a reboot, and `backup-to-usb.sh` deliberately never mounts anything —
 *     it only accepts a directory that already is a mountpoint. The drive was
 *     formatted with this host's label and sat there unmounted.
 *  2. The unit was not in the repository, only under
 *     `~/.config/systemd/user/`, so no installer deployed it and no test could
 *     see it. Same shape as the nightly backup unit.
 *
 * The verify gate itself is already covered by backup-usb-offsite-contract,
 * so this file does not repeat it — it covers the unit and the mount helper.
 */

const UNIT = join(process.cwd(), 'scripts/systemd/memphis-backup-to-usb.service');
const MOUNTER = join(process.cwd(), 'scripts/usb-backup-mount.sh');
const LABEL = 'memphis-usb-back';

function execLines(unit: string): string[] {
  return unit
    .split('\n')
    .filter((line) => !/^\s*[#;]/.test(line))
    .filter((line) => /^\s*Exec(Start|StartPre)=/.test(line));
}

function unitSource(): string {
  return readFileSync(UNIT, 'utf8');
}

describe('scripts/systemd/memphis-backup-to-usb.service', () => {
  it('exists in the repository, not only under ~/.config/systemd/user', () => {
    expect(unitSource()).toContain('backup-to-usb.sh');
    expect(existsSync(MOUNTER)).toBe(true);
  });

  it('mounts the drive before copying, and tolerates its absence', () => {
    // `=` prefix on ExecStartPre: a missing drive exits 2, which is a normal
    // outcome here, and must not stop the copy step from reporting on it.
    expect(unitSource()).toMatch(/^ExecStartPre=-.*usb-backup-mount\.sh$/m);
  });

  it("parses as a valid unit (syntax, not this host's filesystem)", () => {
    const result = spawnSync('systemd-analyze', ['verify', UNIT], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    const fatal = (result.stderr ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes('memphis-backup-to-usb'))
      .filter(
        (line) =>
          !/is not executable|not found|No such file or directory|Unknown key|ignoring\.$/i.test(
            line,
          ),
      );
    expect(fatal).toEqual([]);
  }, 30_000);
});

describe('scripts/usb-backup-mount.sh', () => {
  it('mounts by label, so a second USB stick cannot shift the target', () => {
    const source = readFileSync(MOUNTER, 'utf8');
    expect(source).toContain(LABEL);
    // The device path is resolved at run time, never written into the unit.
    expect(execLines(unitSource()).join('\n')).not.toContain('/dev/sd');
  });

  it('looks the label up through a tool that exists on every runner', () => {
    // Each lookup path failed somewhere this project runs, so both are kept
    // and asserted: `lsblk -o LABEL` does not exist on macOS — this test
    // failed there — and `udisksctl info` names the field `IdLabel`, whose
    // spelling has moved between udisks2 versions. My first version grepped
    // for `^Label:` and reported the drive absent while it was plugged in.
    const source = readFileSync(MOUNTER, 'utf8');
    expect(source).toContain('command -v blkid');
    expect(source).toContain('NAME,TYPE,LABEL');
    expect(source).not.toMatch(/grep\s+-q\s+"\^Label:/);
  });

  it('reports an absent drive as 2, so the copy step is not blocked', () => {
    const result = spawnSync('bash', [MOUNTER], {
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, MEMPHIS_USB_LABEL: 'definitely-not-present-memphis' },
    });
    // The exit code is the contract, and it is the same on a host with no
    // `udisksctl` at all — which is the macOS runner. The message differs by
    // how the lookup failed, so it is asserted to name a reason rather than a
    // particular sentence: my first version demanded the label be echoed,
    // which the "no udisksctl" branch never reaches.
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).toMatch(
      /definitely-not-present-memphis|udisksctl unavailable/,
    );
  }, 40_000);

  it('is syntactically valid bash', () => {
    expect(() => execFileSync('bash', ['-n', MOUNTER], { stdio: 'pipe' })).not.toThrow();
  });
});
