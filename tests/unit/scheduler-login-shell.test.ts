import { describe, expect, it } from 'vitest';

import { executeCommand } from '../../src/infra/runtime/scheduler.js';

describe('scheduler shell tasks run in login shell', () => {
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
});
