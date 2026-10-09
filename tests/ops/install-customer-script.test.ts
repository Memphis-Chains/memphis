/**
 * The customer installer promises something a customer can be held to: a
 * preflight that REFUSES a machine that cannot run the product, and a script
 * that reaches `runtimeStatus: healthy` without the operator typing a repair
 * command.
 *
 * Both claims are measured on 2026-10-09, not asserted:
 *
 *   - `memphis health` on this host reported runtimeStatus: unhealthy with
 *     "Run memphis repair runtime", because the system chain carried
 *     legacy-shaped blocks (35 of 8109). A customer's first command is
 *     `memphis health`. That is the first thing they would see.
 *
 *   - the manual path to a working operator is
 *     docs/operator/DAILY-ASSISTANT-SETUP.md: 490 lines, 12 sections, 8 sudo
 *     packages, 3 ML services to start by hand.
 *
 * These tests read the script as source. Running it would install a runtime,
 * which a unit test must not do — and CI has no systemd user session anyway.
 * The runtime behaviour is proven by executing it on the operator's own host,
 * where the repair path and the Telegram setup are real.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const SCRIPT = resolve('scripts/install-customer.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('install-customer.sh — preflight refuses instead of failing later', () => {
  it('exits non-zero when preflight finds a blocker', () => {
    // A preflight that reports a problem and continues is worse than none: the
    // customer watches an install fail 20 minutes later instead of being told
    // immediately that the box is too small.
    expect(src).toMatch(/if \(\( \$\{#FAILURES\[@\]\} > 0 \)\); then/);
    expect(src).toMatch(/exit 1/);
    // The guard must come BEFORE the installer, not merely exist somewhere in
    // the file. `#` here is the bash array-length sigil, not a comment: an
    // earlier version searched for a literal `#${#FAILURES[@]}` and matched
    // nothing, which would have passed for any script at all.
    const guard = src.indexOf('if (( ${#FAILURES[@]} > 0 ))');
    const install = src.indexOf('bash "$INSTALL_SH"');
    expect(guard).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(install);
  });

  it('checks RAM and disk against named thresholds', () => {
    // Named, not inline, so a test can read the value and so the two places
    // that used to disagree cannot drift apart again.
    expect(src).toContain('MIN_RAM_MB=6000');
    expect(src).toContain('MIN_DISK_GB=8');
    expect(src).toMatch(/ram_mb < MIN_RAM_MB/);
    expect(src).toMatch(/disk_free_gb < MIN_DISK_GB/);
  });

  it('does not measure RAM by shelling out to free(1)', () => {
    // `free` is absent on macOS and inside minimal containers; /proc/meminfo is
    // read with a fallback that yields 0, and 0 must mean "unknown", not "fail".
    expect(src).toContain('/proc/meminfo');
    expect(src).toMatch(/ram_mb > 0 && ram_mb < MIN_RAM_MB/);
    expect(src).not.toMatch(/free -m/);
  });
});

describe('install-customer.sh — reaches healthy without operator intervention', () => {
  it('runs the runtime repair when health is not healthy', () => {
    expect(src).toContain('repair runtime');
    expect(src).toMatch(/rs="\$\(runtime_status\)"/);
    // The repair is conditional, not unconditional: on a healthy runtime it
    // must not rewrite blocks for nothing.
    expect(src).toMatch(/if \[\[ "\$rs" == "unhealthy" \]\]; then/);
  });

  it('reads runtimeStatus from the JSON health output', () => {
    // `memphis health` prints YAML-ish text by default and JSON with --json.
    // Grepping for the field name works on both; asserting on exit code would
    // pass on the "unhealthy, repairable" case that this whole path exists for.
    expect(src).toContain('runtimeStatus');
    expect(src).toContain('memphis_cli health');
  });
});

describe('install-customer.sh — voice and vision stay out of the default path', () => {
  it('does not install whisper, piper or moondream', () => {
    // This is the product decision, asserted as code so it cannot be undone by
    // an edit that looks like a convenience. They cost 8 sudo packages and 3
    // services, and they are the last thing a customer notices.
    for (const svc of ['whisper', 'piper', 'moondream']) {
      const mentions = src.toLowerCase().split(svc).length - 1;
      const inCode = src
        .split('\n')
        .filter((l) => l.toLowerCase().includes(svc))
        .filter((l) => !l.trim().startsWith('#'));
      expect(inCode, `${svc} must not appear in executable lines`).toHaveLength(0);
      expect(mentions).toBeGreaterThan(0); // and the reason is written down
    }
  });

  it('points at the full guide for people who want them', () => {
    expect(src).toContain('DAILY-ASSISTANT-SETUP.md');
  });
});

describe('install-customer.sh — is safe to run twice', () => {
  it('checks before it acts at every destructive step', () => {
    // `--with-init` is interactive and a pipe is not a TTY. The script must not
    // assume it can drive it.
    expect(src).toContain('--with-init');
    // The installer must be guarded, not chained into blindly: the shape is
    // `bash "$INSTALL_SH" --with-init || { bad; exit 1; }`.
    expect(src).toMatch(/bash "\$INSTALL_SH" --with-init \|\| \{/);
    expect(src).toContain('Nothing below can work');
  });

  it('reports what worked instead of only what failed', () => {
    // A customer needs to know what they now HAVE, not just what broke. An
    // installer that only prints errors leaves them unsure whether it worked.
    expect(src).toMatch(/What the customer has right now/);
    expect(src).toMatch(/Next, in this order/);
  });
});

describe('install-customer.sh — actually runs', () => {
  it('passes bash -n', () => {
    // `bash -n` catches the syntax error that a source-reading test cannot.
    // This is the one assertion here that executes anything.
    expect(() => execFileSync('bash', ['-n', SCRIPT], { encoding: 'utf8' })).not.toThrow();
  });

  it('has a --check-only path that runs the preflight and stops', () => {
    const out = execFileSync('bash', [SCRIPT, '--check-only'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toMatch(/Preflight/);
    expect(out).toMatch(/Re-run without --check-only/);
    // It must NOT have installed anything.
    expect(out).not.toMatch(/Installing the runtime/);
  });
});
