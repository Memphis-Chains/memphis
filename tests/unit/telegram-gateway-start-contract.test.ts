import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The Telegram gateway must not discard the operator's messages, and a
 * failed start must be visible.
 *
 * Measured 2026-11-19: the gateway restarted at 22:17 and no inbound
 * update was ever logged (`telegram.inbound`: 88 entries historically,
 * the last one at 20:06, zero afterwards), while Telegram reported
 * `pending_update_count: 0`, an empty `getUpdates` result and a live
 * long-poll connection. `activeSurfaces` was empty.
 *
 * Two causes, both in `src/gateway/channels/telegram.ts`:
 *
 * 1. `bot.start({ drop_pending_updates: true })` — grammY forwards the
 *    flag to `deleteWebhook`, which DISCARDS every update queued while
 *    the gateway was down. The message the operator wrote while the
 *    service was restarting is exactly the one that disappears.
 *
 * 2. `void bot.start(...)` — the promise was neither awaited nor
 *    caught. grammY rejects on 401 Unauthorized and 409 Conflict (another
 *    poller holds the token). The rejection landed in an unhandled
 *    promise, so the log said "Channel gateway started (Telegram)" and
 *    nothing ever arrived. A failure that looks like silence is the
 *    same shape as the silent telemetry sink fixed in PR #728.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  path.join(here, '..', '..', 'src', 'gateway', 'channels', 'telegram.ts'),
  'utf8',
);

/**
 * The EXECUTABLE lines only.
 *
 * The comment above `bot.start` explains this fix in prose, and it
 * mentions `drop_pending_updates: true` and `void bot.start(...)` — the
 * very strings the contract forbids. A gate that reads the whole file
 * reads its own documentation and fails forever. This is the same trap
 * as the CI job-block that matched its own comment.
 */
function executableLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

const code = executableLines(source);

describe('the Telegram gateway start contract', () => {
  it('does not discard the updates queued while it was down', () => {
    expect(code).toContain('drop_pending_updates: false');
    expect(code).not.toMatch(/drop_pending_updates:\s*true/);
  });

  it('catches a failed start instead of losing it in an unhandled promise', () => {
    const startCall = code.slice(code.indexOf('bot.start('));
    expect(startCall).toContain('.catch(');
    // A bare `void bot.start(...)` with no handler is the bug.
    expect(startCall.slice(0, 200)).not.toMatch(/bot\.start\([^)]*\);\s*$/m);
  });

  it('logs the failure — a start that fails must not look like silence', () => {
    const startCall = code.slice(code.indexOf('bot.start('));
    expect(startCall).toContain('log.error');
    // The logger is created at module level, above the start call, so it
    // is checked on its own rather than inside the start block.
    expect(code).toContain("component: 'telegram.gateway'");
  });
});
