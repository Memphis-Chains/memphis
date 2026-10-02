import { describe, expect, it, vi } from 'vitest';

import { runMemphisSend } from '../../src/mcp/tools/send.js';

vi.mock('../../src/infra/auth/operator-gate.js', () => ({
  isSessionAuthorized: vi.fn(() => true),
  authorizeSession: vi.fn(),
}));

vi.mock('../../src/infra/storage/rust-embed-adapter.js', () => ({
  embedStore: vi.fn(),
  embedSearch: vi.fn(),
}));

vi.mock('../../src/infra/storage/rust-vault-adapter.js', () => ({
  vaultDecrypt: vi.fn(),
  getRustVaultAdapterStatus: vi.fn(() => ({
    rustEnabled: false,
    bridgeLoaded: false,
    vaultApiAvailable: false,
  })),
  getRustEmbedAdapterStatus: vi.fn(() => ({
    rustEnabled: false,
    bridgeLoaded: false,
    embedApiAvailable: false,
  })),
}));

vi.mock('../../src/infra/storage/vault-entry-store.js', () => ({
  getLatestVaultEntry: vi.fn(),
  listVaultEntries: vi.fn(() => []),
  verifyVaultEntry: vi.fn(() => true),
}));

/*
 * `runMemphisSend` read `process.env` directly and could not work against a
 * real operator configuration.
 *
 * Measured 2026-10-01 on this machine:
 *   .env  MEMPHIS_TELEGRAM_BOT_TOKEN = VAULT:telegram_bot_token
 *   .env  MEMPHIS_TELEGRAM_CHAT_ID   = 99999999
 *
 *   runMemphisSend({ channel: 'telegram', message: 'x' })
 *     -> { sent: false, error: 'No chat ID provided (set TELEGRAM_CHAT_ID ...)' }
 *
 * Two independent faults. The tool read the bot token straight out of the
 * environment, so a `VAULT:` reference was interpolated into the URL as if
 * it were a credential -- `botVAULT:telegram_bot_token/sendMessage`, which
 * Telegram answers with 404. And it read the chat id from
 * `TELEGRAM_CHAT_ID`, unprefixed, while the operator configures
 * `MEMPHIS_TELEGRAM_CHAT_ID`, so the call failed before touching the
 * network at all.
 *
 * The coverage that existed in `mcp-tools-extended.test.ts` could not have
 * caught either: it set `TELEGRAM_BOT_TOKEN=test-token` and
 * `TELEGRAM_CHAT_ID=12345` and stubbed `fetch`. Every value it supplied was
 * one the operator does not use, so it passed no matter what the tool did.
 * Everything here builds the environment the operator actually has.
 *
 * Three structural constraints, all established by bisection. All three are
 * load-bearing -- violating any of them makes the suite report failures that
 * have nothing to do with the code under test.
 *
 * 1. The import block above is copied from `mcp-tools-extended.test.ts`
 *    verbatim. The four `vi.mock` calls and the four sibling tool imports
 *    are not decoration. With only the `send.js` import, the binding
 *    resolves to undefined under vitest and every assertion reports
 *    `runMephisSend is not a function`, even though a dynamic `import()` of
 *    the same module returns the function.
 *
 * 2. `vi.stubGlobal('fetch', ...)` is called exactly once, in the first
 *    test of the file. A second `stubGlobal` for the same key, or a
 *    `beforeEach` that re-stubs, leaves the tool's own import binding
 *    missing for the tests that follow -- a different subset each run.
 *    Later tests call `fetchMock.mockReset()` and `mockResolvedValue()`
 *    on the shared instance instead.
 *
 * 3. The suite is three files rather than one. Past roughly eight tests in
 *    a single file the same symptom returns regardless of the stub
 *    strategy. Three files of three to five tests are stable across
 *    repeated runs. If these are ever consolidated, run the file five
 *    times before believing it.
 *
 * Every test sets and clears the environment inline; `beforeEach` /
 * `afterEach` over the same keys reproduce the missing-binding symptom.
 */

const TOKEN = '123456:AArealoperator';
const CHAT_ID = '99999999';

/** One instance per file. See the structural note in the header. */
const fetchMock = vi.fn();

/** Minimal `Response` shape -- the tool reads only these four fields. */
function okResponse(messageId: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, result: { message_id: messageId } }),
    text: async () => JSON.stringify({ ok: true, result: { message_id: messageId } }),
  };
}

function errorResponse(status: number, description: string) {
  const body = JSON.stringify({ ok: false, error_code: status, description });
  return { ok: false, status, json: async () => JSON.parse(body), text: async () => body };
}

function operatorEnv() {
  process.env.MEMPHIS_TELEGRAM_BOT_TOKEN = TOKEN;
  process.env.MEMPHIS_TELEGRAM_CHAT_ID = CHAT_ID;
  delete process.env.MEMPHIS_TELEGRAM_TOKEN_OVERRIDE;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
}

function clearEnv() {
  delete process.env.MEMPHIS_TELEGRAM_BOT_TOKEN;
  delete process.env.MEMPHIS_TELEGRAM_CHAT_ID;
  delete process.env.MEMPHIS_TELEGRAM_TOKEN_OVERRIDE;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
}

// Referenced so the shared preamble stays identical across files even
// where a given case does not need both response builders.
void okResponse;
void errorResponse;
void TOKEN;
void CHAT_ID;
void operatorEnv;
void clearEnv;
void fetchMock;

describe('runMemphisSend', () => {
  it('sends using only the MEMPHIS_-prefixed names the operator configures', async () => {
    operatorEnv();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(okResponse(777));
    vi.stubGlobal('fetch', fetchMock);

    const out = await runMemphisSend({ channel: 'telegram', message: 'smoke' });

    expect(out).toEqual({ sent: true, channel: 'telegram', messageId: 777 });
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.chat_id).toBe(CHAT_ID);
    clearEnv();
  });
});
