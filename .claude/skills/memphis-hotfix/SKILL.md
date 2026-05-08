---
name: memphis-hotfix
description: Drive a Memphis hotfix end-to-end with the cross-layer grid as a forcing function. Use when fixing a bug that may touch more than one layer (Rust core, NAPI bridge, TS host, CLI, Tauri, doctor/status, tests). Auto-loads the grid template, the bundled-PR Codex pattern, and the rebuild reminder.
allowed-tools: Bash, Read, Edit, Write, Grep, Glob
---

# Memphis hotfix workflow

Memphis spans Rust core → NAPI bridge → TS host → multiple surfaces (CLI, TUI, HTTP, MCP, Telegram). A bug that "looks Rust-only" almost always has a TS-side rendering, a doctor/status visibility hook, and a test grid. Skipping the grid is the #1 source of dead-end fixes.

## Trigger conditions

- Operator says "fix this" / "naprawa" / "hotfix" / a bug ticket reference
- A live runtime issue surfaced in the chat (error message, unexpected behavior)
- A Codex review finding that needs a code change

## Inputs the assistant must collect or infer

1. **Scope** — one sentence. What is broken. Quote the operator if possible.
2. **Affected layers** — check each row of the grid below; mark `✅` (touches), `–` (no), `🔧` (transparent change like rebuild).
3. **References** — any PR numbers, memory entries, postmortem docs that anchor the fix.
4. **Codex round** — if this is a follow-on to an earlier fix, note the round number per `feedback_codex_bundled_hotfix`.

If any of these are unclear, ask the operator before coding.

## The Cross-Layer Grid (forcing function)

Every Memphis hotfix MUST be evaluated against this grid. Every row gets a verdict — even `–` is a deliberate decision.

| Layer | Files / responsibility | Common verdict |
|---|---|---|
| **Rust core** | `crates/memphis-{core,operator,vault,case-index,embed}/src/` | ✅ if behavior bug; – if rendering only |
| **NAPI bridge** | `crates/memphis-napi/src/lib.rs`; surfacing types | 🔧 (rebuild) if Rust changed; ✅ if signature change |
| **TS host** | `src/gateway/`, `src/cognitive/`, `src/infra/` | ✅ if envelope/error/state surfaced |
| **CLI** | `src/infra/cli/commands/`, `src/infra/cli/handlers/` | ✅ if user-visible flag/output |
| **Tauri** | future shell at `tauri/` (placeholder for now) | – usually; 📝 if cross-cutting |
| **doctor / status** | `src/infra/cli/utils/doctor-v2.ts`, `src/infra/http/health.ts` | ✅ if observability hook earned |
| **tests** | `tests/unit/`, `tests/integration/`, `tests/conformance/` | ✅ always — at minimum a regression |

After implementing, paste the grid into the PR body. The exact format:

```markdown
## Cross-Layer Grid

| Layer | Status |
|---|---|
| Rust core | ✅ <files> |
| NAPI bridge | 🔧 rebuilt; no signature change |
| TS host | ✅ <files> or – <reason> |
| CLI | ✅ <files> or – <reason> |
| Tauri | – |
| doctor/status | ✅ <files> or – <reason> |
| tests | ✅ <files> |
```

## Workflow

### 1. State the scope, draft the grid

Write 2–3 sentences describing the bug and which grid layers are in scope. Get operator confirmation if scope is ambiguous.

### 2. Find the surface area

Use Grep liberally. For a runtime bug, grep the user-facing error message verbatim — that lands you at the constructor site and you can walk back to the cause.

### 3. Implement minimum-diff fix

- One logical change per commit
- No drive-by formatting (run `cargo fmt` only on the file you touched, and check `git diff --stat` to revert any incidental formatting cargo fmt does to other files)
- Tests in the same crate/module as the fix when possible

### 4. Build the appropriate layers

- Rust changed → invoke `/memphis-rebuild-rust` skill (or `npm run build:rust`)
- TS changed → no build needed (vitest runs source)
- Both → build:rust first, then `tsc --noEmit` if you want type-check confirmation

### 5. Test

- `cargo test -p <crate>` for Rust-side tests
- `npm test -- <pattern>` for TS-side
- For integration tests, prefer running the single test file (`npm test -- tests/integration/<name>.test.ts`) — full suite has known races (#270)

### 6. Commit

Branch convention:
- Bug → `fix/<area>-<short-handle>` (e.g. `fix/provider-context-overflow-false-positive`)
- Codex round → `hotfix/codex-round-<N>`
- Stacked on another PR → `fix/<area>-on-<parent-branch>` or use `--base` with stacked-PR conventions

Commit footer must include:
```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

If the change is Rust-side, mention the rebuild requirement in the commit body — operators pulling main without `npm run build:rust` will have stale runtime.

### 7. Open the PR

Title: `fix(<area>): <one-line>` — under 70 chars.

Body must include:
- `## Summary` (2–3 bullets, focus on WHY)
- `## Tests` (what's covered, what's not)
- `## Cross-Layer Grid` (the table from above)
- `## Test plan` (operator-facing checklist)

### 8. Codex review handling

When Codex reviews land:
- Apply with judgment per `feedback_codex_review_judgment.md` — Memphis conventions take precedence over generic suggestions
- Bundle ALL findings from a batch into ONE follow-on PR per `feedback_codex_bundled_hotfix.md`, not one PR per finding
- Cross-PR findings: rebase + forward via `gh pr comment` per `feedback_cross_pr_codex_handoff.md`

## Anti-patterns

- ❌ "It's just a Rust bug, no TS layer involved" — verify by greppinging the error string anyway
- ❌ Skipping the doctor/status row "because the surface doesn't exist yet" — earn it now if the bug was hard to detect
- ❌ Bundling unrelated formatting in the fix commit — split it
- ❌ Force-pushing to main, ever — feature branches with `--force-with-lease` only
- ❌ `--no-verify` to skip hooks — fix the hook failure instead

## Reference memories

- `feedback_cross_layer_coverage.md` — the grid origin
- `feedback_codex_bundled_hotfix.md` — bundled PR pattern
- `feedback_codex_review_judgment.md` — when to push back
- `feedback_truth_before_refactor.md` — produce CODEBASE-TRUTH-DELTA before larger refactors
- `feedback_napi_rebuild_after_rust_changes.md` — paired with /memphis-rebuild-rust
- `feedback_force_push_rules.md` — main vs feature branches
