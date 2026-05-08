# Memphis — Codebase Truth Delta — 2026-05-08 (evening)

**Supersedes** `docs/dev/CODEBASE-TRUTH-DELTA-2026-05-08.md` for the surfaces touched between 18:00–19:30 (PR #521 → #531).
**Successor to:** the autopilot-day delta documented in the morning truth-delta (handler/auth-gating numbers + P-skip catalog).

This doc captures what changed AFTER the 19h autopilot closed and the post-Zawoja bug-bust shipped 11 PRs. It is delta-only — sections not mentioned here are unchanged from the morning delta or the 04-27 truth snapshot.

---

## §A — Provider context-overflow detection (NEW behaviour)

`crates/memphis-operator/src/provider.rs` — heuristic split into two functions and tightened against generic-vocabulary 400 bodies:

| Function | Old | New |
|---|---|---|
| `is_context_overflow_body` | catch-all `(token AND (exceed OR too long))` | provider-specific markers via `has_explicit_overflow_marker` + narrowed soft fallback requiring the triple `(tokens, context|prompt, overflow verb)` |
| `parse_context_overflow_numbers` | accepted any digit run ≥ 1024 anywhere | digit must sit within ±48 chars of the keyword `token` |
| Caller (`post_response_with_provider`) | always emit `ContextOverflow` if heuristic matched | emit only when parser found a number OR explicit marker present; otherwise fall through to generic error path |

PR #521. Tests: `provider::tests` 36/36 (4 new regressions).

---

## §B — MiniMax M2 / M2.7 context window (correctness fix)

`crates/memphis-operator/src/provider.rs:1337-1352` — `minimax_context_window_tokens`:

| Match | Old | New |
|---|---|---|
| `m2.*` substring | 32_000 | **204_800** (200 × 1024) |
| else (e.g. abab series) | 16_384 | 16_384 (unchanged) |

Now matches `src/providers/capability-matrix.ts:201` and the upstream platform.minimax.chat doc (200k+ context). PR #526.

**Operator-visible impact:** TUI status bar now reports `ctx:200k` for MiniMax M2.7 instead of misleading `ctx:32k`; `derive_context_pressure_summary` uses the correct denominator so `prs:high` only triggers near the real ceiling.

---

## §C — Soul-write Mode B validation (Mode B path now Zod-gated)

Two coupled changes:

1. **`src/gateway/tool-executor.ts:357-380`** (the in-process Mode B dispatch) now runs `soulMemoryUpdateSchema.safeParse` on the `updates` payload before calling `runMemphisSoulWrite`. Mismatches throw `VALIDATION_ERROR` naming the offending path (`updates.user.languages`). Mirrors the MCP server gate at `src/mcp/server.ts:989`.

2. **`src/soul/memory.ts:321-348` `dedupeAppend`** is now defensive against direct callers that bypass the tool-executor gate (reflection-loop, onboarding, seed). String → wrapped as one-item array; non-array non-string → throws `TypeError` with a clear message; mixed-type arrays → non-string entries filtered out.

Closes the live `additions is not iterable` and `memory: null` 2026-05-08 TUI bug. PR #525. Tests: 35/35 (5 new regressions across `soul-memory.test.ts` + `in-process-tool-executor.test.ts`).

---

## §D — Cognitive insight-save envelope (canonical alignment)

`src/infra/cli/commands/cognitive.ts:38-58` — `buildInsightSavePayload` was the odd one out among the three cognitive save-payload builders. Now aligned:

| Payload | Old | New |
|---|---|---|
| `buildInsightSavePayload` | `{type:'insight_report', ...}` | `{type:'insight', kind:'insight_report', ...}` |
| `buildCategorizeSavePayload` | (already canonical) | `{type:'insight', kind:'categorize_report', ...}` |
| `buildReflectionSavePayload` | (already canonical) | `{type:'insight', kind:'reflection_report', ...}` |

The chain-catalog (`src/memory/chain-catalog.ts:68`) only declares `'journal' | 'insight'` as valid BlockType variants for the journal chain, so `'insight_report'` directly was technically out of band. PR #529.

**Downstream impact:**

- `scripts/query-cognitive-reports.mts:165` — reads `block.data.kind` first with `block.data.type` fallback (forward-compat with older snapshots).
- 5 existing tests updated to assert canonical envelope: `tests/unit/cli.insights.test.ts`, `tests/unit/cli.categorize.test.ts`, `tests/integration/cli-insight-alias.e2e.test.ts`, `tests/integration/cli-categorize-save.e2e.test.ts`, `tests/integration/cli-save-persistence.e2e.test.ts`.
- 4 P5 cognitive-report-query tests now read `kind` and pin `DEFAULT_PROVIDER=local-fallback` (PR #530).

---

## §E — Chain-adapter integrity error format (UX fix)

`src/infra/storage/chain-adapter.ts:516-580` — five error sites in `readAndValidateChainBlocks` upgraded:

```
Old: "chain integrity check failed for 00042.json: hash mismatch"
New: "chain 'journal' integrity check failed at block 42 (00042.json):
      stored hash c32a7fa8…cc18 ≠ computed e7528cc4…e681. Run
      `memphis repair runtime` or set MEMPHIS_CHAIN_REPAIR_ON_MISMATCH=true
      to auto-heal."
```

Adds: chain name, block index, hash fingerprints (8+4 hex chars), explicit remediation pointer. Same enrichment for hash-mismatch / missing-genesis / genesis-prev-hash / mid-chain-prev-hash / non-sequential-index. PR #527. Tests: 14/14 (1 new regression + 2 updated existing).

---

## §F — MCP-registered tools (added 2)

`src/mcp/server.ts` — registered two `TOOL_REGISTRY` entries that previously had no `server.registerTool` call:

- `memphis_brave_search` (registry line 941, ~web tier 2)
- `memphis_media_ingest` (registry line 981, ~media tier 2)

Both register unconditionally (no feature flag). PR #523 in earlier phase. Closes registry⇄MCP drift; `mcp-introspection-contract` tests 4/4 green.

---

## §G — Inline-skipped tests catalog (was 9 → now 0)

The morning delta listed 9 inline `it.skip(...)` cases across 6 files (P5/P6/P7/P8). Status now:

| Skip family | Count | Status |
|---|---|---|
| P5 cognitive-report-query | 4 | **REVIVED** (PR #530) |
| P6 consent-mark | 1 | REVIVED (PR #523) |
| P6 mcp-introspection-contract | 2 | REVIVED (PR #523) |
| P6 cli.categorize / cli-save-persistence / cli-categorize-save | 3 | **REVIVED** (PR #529) |
| P7/P8 incident-bundle-manifest-verify | 2 | **REVIVED** (PR #531) |
| **Total inline `it.skip`** | **12** | **0 inline skips remaining** |

Three legitimate `describe.skipIf` cases remain — those are environment-conditional (TUI binary present, bridge build available, stress-flag enabled), not bug-skips:
- `tests/integration/tui-binary-smoke.test.ts:64` — needs prebuilt TUI binary
- `tests/integration/script-shutdown-segv-stress.test.ts:109` — needs bridge build
- `tests/integration/shutdown-segv-stress.test.ts:353` — needs `STRESS_ENABLED=1`

---

## §H — Issue #270 vitest race — Track A active

`vitest.config.ts` and `tests/integration/script-shutdown-segv-stress.test.ts` carry race-tolerance gates (PR #528):

| Knob | Default | Override |
|---|---|---|
| `dangerouslyIgnoreUnhandledErrors` (vitest config) | `true` (suppresses post-test pool-level "Worker forks emitted error") | `MEMPHIS_STRICT_VITEST_RACE=1` to surface |
| `SEGV_STRESS_MAX_TOLERATED_FAILURES` (stress test) | `1` (out of 10 iterations) | `MEMPHIS_STRICT_SEGV_STRESS=1` to force zero-tolerance |

Both gates are scoped strictly to the V8↔Rust dlclose race; real test failures still surface through normal assertion paths. Track B (Rust-side teardown barrier in `crates/memphis-napi`) is the long-term resolution and is the next focused-session item.

---

## §I — Claude Code skills (NEW persistent tooling)

`.claude/skills/` is a new directory tracked in git. Two skills auto-loadable in future Claude Code sessions:

| Skill | Trigger | Purpose |
|---|---|---|
| `memphis-rebuild-rust` | `paths:` glob `crates/**/*.rs` (auto) | NAPI rebuild + restart procedure after Rust crate changes |
| `memphis-hotfix` | explicit `/memphis-hotfix` invocation | Cross-Layer Grid as forcing function for Rust\|NAPI\|TS\|CLI\|Tauri\|doctor\|tests work |

PR #522. See `feedback_claude_code_optimization_for_memphis.md` for the broader 6-move plan.

---

## §J — Roadmap doc captured

`docs/roadmap/post-v1.9-broad-roadmap.md` captures the operator-dictated 6-item post-v1.9 direction with a suggested Tier 1/2/3 ordering (PR #524). Operator-stated "discuss after current sprint" — that conversation is the next non-bug item once Track B lands or is consciously deferred.

---

## §K — Counts diff vs morning delta

| Metric | Morning delta (post-autopilot) | Evening delta (post-bug-bust) |
|---|---|---|
| Total CLI handlers | 34 | 34 |
| Handlers + commands gating | 7 / 60 (12%) | 7 / 60 (12%) — unchanged |
| Inline `it.skip(...)` cases | 9 | **0** (all revived) |
| Cognitive handlers using canonical envelope | 2 / 3 (categorize, reflect) | **3 / 3** (insights aligned) |
| MCP-registered tools that exist in TOOL_REGISTRY | 33 / 35 | **35 / 35** (brave + media added) |
| Mode B (gateway tool-executor) Zod-gated tools | mostly free-form `requiredRecord` | soul_write now Zod-gated; rest unchanged |
| `.claude/skills/` slots | 0 | 2 |

Issue #278 (5 ungated handlers — provider/worker/telegram/consent/schedule) **was already closed** in PR #520-era of the morning autopilot — the gating was applied there. The morning delta predates that close-out and shows the pre-gating state for historical reference; both should be read together for accurate handler-gating count (post-#278 close-out: 12 / 60).

---

## Notes for next session

- Track B vitest race is the queued follow-up. Memory entry `feedback_inline_p_skip_pattern.md` and PR #528's commit body have the full context.
- Roadmap discussion (`docs/roadmap/post-v1.9-broad-roadmap.md`) waits on operator-go.
- The morning delta (`CODEBASE-TRUTH-DELTA-2026-05-08.md`) is still authoritative for the §5 handler-gating matrix; this evening delta layers on top for the surfaces touched in PRs #521-#531.

---

**Generated:** 2026-05-08 evening, post bug-bust autopilot (operator: "samemu az do konca bugow").
**Method:** `git log --oneline d883f3d6..HEAD` for the 11 PR cohort, plus per-PR cross-reference to handler/test/script files.
