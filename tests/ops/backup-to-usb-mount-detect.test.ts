import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const scriptPath = path.join(repoRoot, 'scripts', 'backup-to-usb.sh');

// Regression test for the 2026-09-29 silent failure: USB_DIR was
// hardcoded to /media/memphis/usb-backup (pre-XDG automount), while
// this host mounts through systemd at /run/media/$USER/<label>. Every
// run logged "not a mountpoint", exited 2, and SuccessExitStatus=0 1 2
// in memphis-backup-to-usb.service reported it as success. Offsite
// backup went 2+ days stale with nothing escalating.
//
// These tests never write to a real mountpoint. They assert the SOURCE
// contract (probing, override, explicit error) plus one behavioural
// check that the script does not silently succeed on a bad path.

const source = readFileSync(scriptPath, 'utf8');

describe('scripts/backup-to-usb.sh — USB mount detection contract', () => {
  it('does not assign USB_DIR from a single hardcoded literal', () => {
    // The bug shape: `USB_DIR="/media/memphis/usb-backup"`.
    expect(source).not.toMatch(/^\s*USB_DIR="\//m);
  });

  it('resolves the mount through a candidate probe', () => {
    expect(source).toContain('resolve_usb_dir');
  });

  it('probes the systemd automount location', () => {
    // `$USER` expanded to a `local user="${USER:-$(id -un)}"` local on
    // 2026-10-08: under `set -u` an unset USER aborted the whole script
    // with rc=1 before the probe could report its own "no mount" code 2.
    // The path shape is the contract; the variable name is not.
    expect(source).toMatch(/local user="\$\{USER:-\$\(id -un\)\}"/);
    expect(source).toContain('/run/media/$user/memphis-usb-back');
  });

  it('probes the legacy udisks2 locations too', () => {
    expect(source).toContain('/media/$user/usb-backup');
    expect(source).toContain('/media/memphis/usb-backup');
  });

  it('checks every candidate with mountpoint -q', () => {
    expect(source).toMatch(/mountpoint -q "\$d"/);
  });

  it('consults MEMPHIS_USB_DIR before the built-in candidates', () => {
    // Compare CODE positions. The prose comment above the function
    // also names the variable, so a plain indexOf finds the wrong spot.
    const overrideAppend = source.indexOf('candidates+=("$MEMPHIS_USB_DIR")');
    const firstBuiltin = source.indexOf('/run/media/$user/memphis-usb-back');
    expect(overrideAppend).toBeGreaterThan(-1);
    expect(firstBuiltin).toBeGreaterThan(-1);
    expect(overrideAppend).toBeLessThan(firstBuiltin);
  });

  it('names every probed path in the not-found error', () => {
    expect(source).toMatch(/no USB mount found/);
    expect(source).toContain('tried MEMPHIS_USB_DIR');
  });

  it('uses a real mountpoint check rather than a bare -d test', () => {
    // A plain -d check would accept the stale empty directory that
    // caused the original false "mounted" impression.
    expect(source).toContain('mountpoint -q');
  });
});

describe('scripts/backup-to-usb.sh — safety constants', () => {
  it('keeps the rotation bound at 3 archives', () => {
    expect(source).toMatch(/^USB_KEEP=3\b/m);
  });

  it('keeps a 200 MB free-space floor', () => {
    expect(source).toMatch(/^MIN_FREE_MB=200\b/m);
  });

  it('refuses to write a write-test file it cannot remove', () => {
    expect(source).toMatch(/rm -f "\$USB_DIR\/\.write-test"/);
  });
});

describe('scripts/backup-to-usb.sh — runtime', () => {
  it('passes shell syntax validation', () => {
    const result = spawnSync('bash', ['-n', scriptPath], {
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('never reports success on a non-mountpoint path', () => {
    const fakeRoot = mkdtempSync(path.join(tmpdir(), 'backup-to-usb-'));
    try {
      const fakeUsb = path.join(fakeRoot, 'not-a-mount');
      mkdirSync(fakeUsb, { recursive: true });
      // Point every built-in candidate at the same plain directory so
      // no real mount on this host can satisfy the probe.
      const result = spawnSync(
        'bash',
        [
          '-c',
          `
          set -e
          mount() { return 1; }   # every path is a non-mount
          export -f mount 2>/dev/null || true
          MEMPHIS_USB_DIR=${JSON.stringify(fakeUsb)} \\
            HOME=${JSON.stringify(fakeRoot)} \\
            bash ${JSON.stringify(scriptPath)}
        `,
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          timeout: 30_000,
          env: { ...process.env, PATH: '/usr/bin:/bin' },
        },
      );

      // The original defect: exit 2 with a "not a mountpoint" message
      // that the unit file treats as SUCCESS. Exit 2 is still correct
      // for a genuinely absent USB, but the stderr must be explicit
      // about which paths were tried.
      expect([1, 2]).toContain(result.status);
      expect(result.stdout + result.stderr).toMatch(/no USB mount found|USB mount|not-a-mount/);
    } finally {
      rmSync(fakeRoot, { recursive: true, force: true });
    }
  });
});
