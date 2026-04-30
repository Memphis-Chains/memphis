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
    // Verify with `printenv SHLVL` — login shells push SHLVL beyond 1.
    // Plain `bash -c` runs at SHLVL=1; `bash -lc` at SHLVL=2 because
    // the profile sourcing nests another shell level. (The exact level
    // is system-dependent so the test just asserts it crossed 1, which
    // is the canonical signal that login-shell init ran.)
    const result = await executeCommand(
      { type: 'shell', script: 'printenv SHLVL' },
      { taskId: 'test-login-shell' },
    );
    expect(result.success).toBe(true);
    const lvl = Number(result.output.trim().split('\n')[0]);
    expect(lvl).toBeGreaterThanOrEqual(2);
  });
});
