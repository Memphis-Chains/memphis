# Input Path Drift Summary — 2026-03-28

## Status — RESOLVED (2026-03-29)

All canonical chat paths now converge on `runTurnRuntime`. Interactive chat resolves provider via cascade per-turn (no fixed chatProvider, no throws). Regression tests in `tests/regression/input-path-convergence.test.ts` prove convergence. Provider-only mode remains as explicit opt-in diagnostic path.

### Original Issue (resolved)

Memphis has one intended canonical conversational runtime, but supported user input can still reach it through more than one execution path.

This is not only "three user-facing surfaces." The real issue is that some supported chat flows still bypass the shared turn runtime and fall back to lower-level orchestration helpers.

## What Is True

- There are three ingress surfaces for user input:
  - Rust TUI
  - CLI
  - HTTP
- The intended canonical runtime is [`runTurnRuntime`](../src/gateway/turn-runtime.ts).
- Some supported flows already use that runtime correctly:
  - gateway chat loop in [`src/gateway/chat-loop.ts`](../src/gateway/chat-loop.ts)
  - CLI chat turn wrapper in [`src/infra/cli/chat-turn.ts`](../src/infra/cli/chat-turn.ts)
  - HTTP `/v1/chat/generate` in [`src/infra/http/routes/chat.ts`](../src/infra/http/routes/chat.ts)

## Where The Drift Still Exists

### CLI interaction fallback

[`src/infra/cli/commands/interaction.ts`](../src/infra/cli/commands/interaction.ts) still chooses between:

- `runInteractiveAgentTurn(...)` -> `runChatTurn(...)` -> `runTurnRuntime(...)`
- `context.getContainer().orchestration.generate(...)`

That means supported CLI interaction can still bypass the canonical turn runtime.

### Interactive CLI fallback

[`src/infra/cli/interactive-chat.ts`](../src/infra/cli/interactive-chat.ts) still chooses between:

- `runChatTurn(...)` -> `runTurnRuntime(...)`
- `options.orchestration.generate(...)`

That means interactive chat can silently downgrade to a parallel path when `chatProvider` is missing.

### HTTP fallback

[`src/infra/http/routes/chat.ts`](../src/infra/http/routes/chat.ts) still chooses between:

- `runTurnRuntime(...)`
- `orchestration.chat(...)`
- `orchestration.generate(...)`

That means `/v1/chat/generate` is not fully guaranteed to stay on the canonical runtime when runtime dependencies are missing.

## Why This Is A Problem

- The product claims one canonical turn runtime.
- The code still permits conversational fallback paths.
- This makes behavior depend on dependency resolution rather than the supported product contract.
- It weakens memory, persistence, tool-loop, and post-response guarantees because the fallback path is not the same runtime contract.
- It makes docs more optimistic than the actual code.

## Important Correction To `feedback.md`

`feedback.md` is partly accurate about the existence of multiple ingress surfaces, but it is not fully accurate about runtime truth.

At least these points are wrong or misleading:

- canonical truth is not "SQLite chains"
  - chain files / chain-backed memory are the canonical truth
  - SQLite and search indexes are derived or operational
- tool use is not simply "not implemented"
  - there is a shared agent/tool loop in the canonical runtime
  - the remaining issue is surface convergence, not total absence of tool execution infrastructure

## Fix Direction

### 1. Remove conversational fallbacks from supported surfaces

Supported chat flows should no longer call:

- `orchestration.generate(...)`
- `orchestration.chat(...)`

as a fallback for normal user input.

### 2. Require canonical runtime dependencies

CLI and HTTP supported chat flows should require the runtime/provider dependencies needed by `runTurnRuntime(...)`.

If those dependencies are missing, Memphis should fail early with a clear runtime/init error instead of silently downgrading to a weaker path.

### 3. Keep orchestration as a low-level helper only

`OrchestrationService` can remain as a provider/helper layer, but not as a parallel conversational runtime for supported user input.

### 4. Add regression tests

Add tests proving:

- supported CLI chat always reaches `runTurnRuntime(...)`
- interactive CLI chat cannot bypass `runTurnRuntime(...)`
- supported HTTP `/v1/chat/generate` always reaches `runTurnRuntime(...)`
- missing runtime dependencies cause explicit failure, not orchestration fallback

### 5. Align docs after code convergence

After fallback removal, refresh runtime docs so they describe real code truth rather than intended architecture only.

## Recommended Priority

This should be treated as a runtime-convergence fix, not just a docs cleanup.

Recommended order:

1. remove CLI fallback paths
2. remove HTTP fallback paths
3. add regression tests
4. then update product/runtime docs
