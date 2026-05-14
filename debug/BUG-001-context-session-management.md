# Bug 001: Context Window & Session Management

**Data:** 2026-05-13  
**Status:** 🟡 Investigating  
**Priority:** 🔴 High  
**Discovered via:** journal + source analysis

---

## Symptoms

1. Status bar shows `ctx:32k · prs:high · rem~:0` after a few conversation turns
2. `/clear` does NOT reset context pressure
3. Long conversations cause context exhaustion

## Root Cause (Suspected)

### Bug A: `/clear` generates new session_id but may not prevent writing to old session

**File:** `crates/memphis-tui/src/app.rs` lines 820–843 + `crates/memphis-operator/src/chat.rs` lines 266–276

The TUI generates a new `chat_session_id` on `/clear`, but the actual SQLite write uses the `session_id` returned from the Rust response. Need to verify if writes go to new or old session row.

### Bug B: `remaining_context_tokens` miscalculation

**File:** `crates/memphis-tui/src/app.rs` line 3936

```rust
let remaining_context_tokens = context_window_tokens.saturating_sub(usage.prompt_tokens);
```

`prompt_tokens` includes system_prompt + all 40 history messages + current input. For a 32k model with system_prompt~8k + history~23k, remaining = 32k - 31k = ~1k.

### Bug C: Rust chat has no access to TypeScript compaction overlays

The TypeScript `conversation-context-service.ts` creates summarized memory blocks, but Rust's `load_chat_rows()` in `chat.rs` reads raw messages only. Both systems are siloed.

## Files Affected

- `crates/memphis-operator/src/chat.rs` — `load_chat_rows`, `persist_chat_messages`, `chat_with_stream`
- `crates/memphis-tui/src/app.rs` — `/clear` handler, `derive_context_pressure_summary`

## Questions

- [ ] Does `/clear` create a new SQLite session row or reuse/overwrite?
- [ ] Does `prompt_tokens` include system_prompt + history?
- [ ] Does compaction overlay reach Rust layer?

---

## CONFIRMED BUGS (2026-05-13 post-merge)

### Bug A: `/clear` works correctly ✅

**VERIFIED — NOT a bug.** After `/clear`:
- TUI generates new `session_id` (e.g. `tui-{:x}`)
- Rust `normalize_session_id()` accepts it as-is (no normalization happens)
- New messages are written to the NEW session_id
- Old session is abandoned but remains in SQLite

Evidence: 17 TUI sessions in `sessions` table, each with messages starting from seq=1. The `primary::operator:local` session stopped receiving messages on 2026-05-12T20:47:01, and 15+ new TUI sessions were created since then.

### Bug B: `remaining_context_tokens` calculation is correct in principle ❌ (NOT the bug)

**VERIFIED — The formula IS correct.** For a 32k context:
```
remaining = context_window - prompt_tokens (what the LLM actually counted)
```
If `prompt_tokens` from MiniMax API = real tokens used = ~7k, then `remaining = 32k - 7k = 25k`.

**The `rem~:0` issue must have another cause** — possibly:
1. A different code path that uses the ESTIMATED calculation (`chars/4`) instead of real API usage
2. Token count from the estimation fallback (when API doesn't return usage)

### Bug C: SQLite query bug in `getSessionSummary` — LIMIT doesn't work on aggregates

**CONFIRMED BUG.** The debug query that used `ORDER BY sequence DESC LIMIT 40` with `get()` + `COUNT(*)` returned 252 (total session count) instead of 40. 

Root cause: `get()` returns first result row; `COUNT(*)` counts ALL rows; `LIMIT 40` limits result rows to 1 (already 1 row from group-by). The LIMIT does NOT filter which rows are counted.

This means any code relying on "last N messages" aggregated data is wrong.

---

## SQLITE DATA ANALYSIS (2026-05-13 20:06)

Database: `/home/memphis/memphis/data/memphis.db` (39MB, 4387 total chat messages)

### Active session: `tui-6a04d067`
- Created: 2026-05-13T19:27:18
- Messages: 252
- Total chars: 180,636
- Sequence: 252 (last seq)

### Session history
```
primary::operator:local   1869 msgs  last: 2026-05-12  ← OLD, abandoned
primary::telegram:...    1036 msgs  last: 2026-05-13  ← Still active
tui-6a04d067              252 msgs  last: 2026-05-13  ← Current (after /clear)
tui-6a03f09b              289 msgs  last: 2026-05-13
tui-6a03ec97               64 msgs  last: 2026-05-13
... (10+ older sessions)
```

### Token math for current session (tui-6a04d067)

System prompt components:
- soul-memory.json: 5,413 chars (~2,030 tokens)
- soul-manifest.json: 2,043 chars (~766 tokens)  
- Total system: ~7,456 chars (~2,796 tokens)

Last 40 messages (actual):
- Est. ~28,640 chars (~10,740 tokens at 1.5x factor)
- With system: ~36,096 chars (~13,536 tokens)

**Context usage: ~42% of 32k window** — NO overflow risk with 40 messages.

But the session has 252 messages (all stored) and if ALL were loaded somehow...

### Real token counts (from API — actual MiniMax usage)

When MiniMax returns `usage.prompt_tokens`, it's the REAL token count from the API:
- Includes system_prompt + all history messages + current input
- This is the accurate number for `remaining_context_tokens` calculation

**Conclusion:** If `rem~:0` appeared in the status bar, it's because:
1. MiniMax IS returning very high `prompt_tokens` (near context limit), OR
2. A fallback estimation path is being used (overestimating tokens)

---

## QUESTIONS ANSWERED

| Question | Answer |
|----------|--------|
| Does `/clear` create a new SQLite session? | ✅ YES — confirmed |
| Does `prompt_tokens` include system_prompt + history? | ✅ YES — it's what LLM counts |
| Does `remaining_context_tokens` formula work correctly? | ✅ YES — formula is correct |
| Is the bug in the formula or the data? | 🔍 Likely: real API returning high usage OR fallback estimation |

---

## QUESTIONS STILL OPEN

- [ ] Why did `rem~:0` appear? Need to reproduce with current session
- [ ] Is there a code path where `chars/4` estimation is used instead of real API usage?
- [ ] The SQL LIMIT bug — does any actual TUI code suffer from it, or only my debug query?

---

## DEEP DIVE RESULTS (2026-05-13, 2nd session)

### Context Window: CORRECT ✅

**MiniMax M2/M2.7 context window = 204_800 tokens** (per commit `fc2a02f6`, 2026-05-08)

The earlier 32k hardcode was stale. Updated to 204_800 (200 × 1024) matching platform.minimax.chat docs.

TS-side (`src/infra/cli/provider-capabilities.ts`): MiniMax uses `openai_compatible_context_window_tokens` which returns 8192 (no "m2" match). **POTENTIAL BUG**: TypeScript side doesn't recognize "MiniMax-M2.7" as needing 204800.

But TUI uses Rust's `provider_statuses()` which correctly calls `minimax_context_window_tokens()`.

### Token Usage Path

```
MiniMax API response (real) → parse_openai_usage() → ChatCompletion.token_usage
                                                          ↓
                              emit_usage_if_changed() [during stream]
                                                          ↓
                              ChatStreamEvent::Usage(usage)
                                                          ↓
                              TUI: WorkerEvent::ChatUsage(usage)
                                                          ↓
                              self.live_token_usage = Some(usage)
                                                          ↓
                              ChatExchange.token_usage (final)
                                                          ↓
                              self.last_token_usage = exchange.token_usage
```

**Key:** For MiniMax, `prompt_tokens` from API = REAL tokens used including system_prompt + history + input.

### Remaining Token Formula: CORRECT ✅

```rust
let remaining = context_window_tokens.saturating_sub(usage.prompt_tokens);
```

For MiniMax M2.7 with 204800 context and `prompt_tokens = real_value`:
- If real usage = 13000 tokens → remaining = 191800 (high)
- If real usage = 200000 tokens → remaining = 4800 (medium)  
- If real usage = 204000 tokens → remaining = 800 (high pressure, not zero!)

**The only way to get `rem~:0` is if `prompt_tokens >= 204800` (overflowing the full context window).**

### Possible `rem~:0` Causes

1. **Mid-stream Usage event** — the Usage emitted DURING streaming (via `emit_usage_if_changed`) reflects cumulative token count, which could approach or exceed the context window on long conversations

2. **Fallback estimation** — when API doesn't return usage, `estimated_chat_usage()` uses `chars/4`. For a 200k char system prompt + history, this could estimate ~50k tokens which would correctly show as ~150k remaining for 204800 window... but if the estimation is somehow feeding the WRONG value...

3. **Model mismatch** — if TUI is showing context window for the WRONG model (e.g., defaulting to Ollama 8k when MiniMax is active), then MiniMax's 13000 actual tokens against 8192 window = overflow

### Files with Real Bugs

| File | Bug | Severity |
|------|-----|----------|
| `src/infra/cli/provider-capabilities.ts` | TS side MiniMax context = 8192 (should be 204800) | 🟡 Medium |
| `crates/memphis-tui/src/app.rs` | Need to verify which `live_token_usage` path triggers `rem~:0` | 🔴 High |
| `crates/memphis-operator/src/provider.rs` | Context overflow detection: explicit marker `context window exceeds` (no -ed) | 🟢 Fixed |

### Questions Still Open

- [ ] Which specific code path triggers `rem~:0`? Need live reproduction
- [ ] Is `live_token_usage` being set from mid-stream usage that accumulates over the session?
- [ ] Does TS-side provider-capabilities.ts affect TUI at all, or is it only for CLI commands?
