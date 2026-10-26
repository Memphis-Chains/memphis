import { afterEach, expect, it, vi } from 'vitest';

import { authorizeSession, clearSessionAuth, isSessionAuthorized } from '../../src/infra/auth/operator-gate.js';
import { withOperatorContext } from '../../src/security/operator-context.js';

afterEach(() => { vi.useRealTimers(); clearSessionAuth(); });
it('isolates concurrent subjects, sessions and surfaces and expires grants', async () => {
  vi.useFakeTimers();
  const alice = { surface: 'mcp', subject: 'alice', sessionId: 'session-one' };
  await withOperatorContext(alice, async () => {
    authorizeSession();
    await Promise.resolve();
    expect(isSessionAuthorized()).toBe(true);
    expect(withOperatorContext({ ...alice, subject: 'bob' }, isSessionAuthorized)).toBe(false);
    expect(withOperatorContext({ ...alice, sessionId: 'session-two' }, isSessionAuthorized)).toBe(false);
    expect(withOperatorContext({ ...alice, surface: 'http' }, isSessionAuthorized)).toBe(false);
    vi.advanceTimersByTime(15 * 60_000);
    expect(isSessionAuthorized()).toBe(false);
    authorizeSession(); clearSessionAuth(); expect(isSessionAuthorized()).toBe(false);
  });
  expect(isSessionAuthorized()).toBe(false);
});
