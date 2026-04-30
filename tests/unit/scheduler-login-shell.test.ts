import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { executeCommand } from '../../src/infra/runtime/scheduler.js';

describe('scheduler shell tasks run in login shell', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('honors PATH from ~/.profile / ~/.bashrc so global npm bins resolve', async () => {
    // Operator pain (Wodzu's 2026-04-30 cron smoke): a task script of
    // `memphis exec "..."` failed daily since 2026-04-26 with
    // `memphis: command not found` because `bash -c` is non-interactive
    // and skips the operator's profile, so ~/.npm-global/bin (where
    // `memphis` lives) is never on PATH.
    //
    // Probe deterministically with `shopt -q login_shell` — that's
    // bash's own self-report of whether it was invoked with -l.
    // Codex P2 round 1 flagged SHLVL as flaky (depends on inherited
    // env and /etc/profile normalization); shopt is the unambiguous
    // signal.
    const result = await executeCommand(
      {
        type: 'shell',
        script:
          'shopt -q login_shell && echo "LOGIN_SHELL_PROBE=yes" || echo "LOGIN_SHELL_PROBE=no"',
      },
      { taskId: 'test-login-shell' },
    );
    expect(result.success).toBe(true);
    // Codex P2 round 2: profile scripts (/etc/profile, ~/.profile,
    // ~/.bash_profile) can prepend banner lines to stdout before our
    // echo, and runShell appends STDERR after stdout — so neither
    // first-line nor last-line is reliable. Use an explicit marker
    // pair: the script prints `LOGIN_SHELL_PROBE=yes/no`, and we look
    // for the exact `=yes` token anywhere in the output.
    expect(result.output).toContain('LOGIN_SHELL_PROBE=yes');
    expect(result.output).not.toContain('LOGIN_SHELL_PROBE=no');
  });

  it('re-asserts cwd after profile sources `cd` (Codex P1 round 1)', async () => {
    // Operator profiles (~/.profile, ~/.bash_profile) commonly contain
    // an unconditional `cd ~/somewhere`. With plain `bash -lc`, that cd
    // would override the cwd spawn() passed in, so a git-pull-build
    // task could end up running outside the scheduler's runtimeRoot.
    // Verify the wrapper re-cd's into the spawn cwd before the script
    // runs, even when HOME points at a profile that cd's elsewhere.
    const homeDir = mkdtempSync(join(tmpdir(), 'scheduler-home-'));
    const decoyDir = mkdtempSync(join(tmpdir(), 'scheduler-decoy-'));
    // Profile cd's into the decoy dir before the task script runs.
    writeFileSync(join(homeDir, '.profile'), `cd "${decoyDir}"\n`);
    process.env.HOME = homeDir;

    const result = await executeCommand(
      { type: 'shell', script: 'echo "PWD=$(pwd)"' },
      { taskId: 'test-cwd-after-profile' },
    );

    expect(result.success).toBe(true);
    // Wrapper re-cd's into runShell's cwd (scheduler project root)
    // BEFORE the task script runs. So pwd at script time is NOT the
    // decoy that profile cd'd into.
    expect(result.output).not.toContain(`PWD=${decoyDir}`);
    // And it's some real path other than empty.
    expect(result.output).toMatch(/PWD=\/.+/);
  });

  it('preserves $0=bash so scripts that re-invoke $0 still work (Codex P2 round 3)', async () => {
    // Plain `bash -c script` sets $0 to bash. The prior wrapper used
    // 'memphis-scheduler' as $0 which broke `$0 -c '...'` patterns
    // (self-reexec, shell detection). Match the prior semantics.
    const result = await executeCommand(
      { type: 'shell', script: 'echo "ARG0=$0"' },
      { taskId: 'test-arg0' },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('ARG0=bash');
    expect(result.output).not.toContain('ARG0=memphis-scheduler');
  });

  it('clears positional args ($@) before eval so task scripts see no ghost args (Codex P2 round 2)', async () => {
    // The wrapper passes cwd + script as positional args to the inner
    // bash, then clears $@ via `set --` before eval'ing. Without that
    // clear, a task script of `echo $#` would print `2` (cwd + script)
    // instead of `0`, and any script branching on positional args
    // would silently take the wrong path.
    const result = await executeCommand(
      { type: 'shell', script: 'echo "ARGC=$#"; echo "ARG1=${1:-EMPTY}"' },
      { taskId: 'test-positional-args' },
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('ARGC=0');
    expect(result.output).toContain('ARG1=EMPTY');
  });
});
