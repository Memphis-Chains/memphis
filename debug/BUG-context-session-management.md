# Bug: Context Window & Session Management

**Data:** 2026-05-13  
**Status:** 🟡 Investigating  
**Priority:** 🔴 High

---

## Scope

Two independent chat systems exist in Memphis:

| System | Location | Used by |
|--------|----------|---------|
| Rust chat | `crates/memphis-operator/src/chat.rs` | TUI (`/clear`, `/session`) |
| TypeScript chat | `src/gateway/chat-loop.ts` | Telegram, Discord, other channels |

---

## Architecture Overview

### Rust Chat (TUI)

```
TUI input → chat_session_id → Rust chat_with_stream()
                              → load_chat_rows(session_id, 40)
                              → build_messages + system_prompt
                              → LLM call
                              → persist_chat_messages(session_id)
```

- **Storage:** SQLite table `operator_chat_messages`
- **History limit:** `CHAT_MAX_MESSAGES_DEFAULT` = 40 messages
- **No compaction:** Rust does NOT use the TypeScript `conversation-context-service`
- **Session:** `session_id` passed from TUI → stored in SQLite row alongside messages

Key files:
- `crates/memphis-operator/src/chat.rs` — main chat logic
- `crates/memphis-tui/src/app.rs` — TUI input handling, `/clear`, `/session`

### TypeScript Chat (Gateway)

```
IncomingMessage → deriveConversationContext()
                             → chat-loop.ts
                             → runTurnRuntime()
                             → getPromptOverlay(conversationId)
                             → sessionMemory + compactions overlays
                             → LLM call
                             → refreshConversation()
```

- **Storage:** TypeScript chains (soul_memory, journal, compactions)
- **Compaction:** Every 24+ messages (pressure-dependent) — older messages summarized into a block
- **Overlays:** session memory summary + compaction blocks + trimmed recent messages

Key files:
- `src/gateway/conversation-context-service.ts` — compaction + session memory
- `src/gateway/chat-loop.ts` — message handling
- `src/gateway/turn-runtime.ts` — turn execution

---

## Known Bugs

### Bug 1: `/clear` does NOT wipe history in SQLite

**Symptom:** After `/clear`, long conversations still trigger `rem~:0` on context pressure.

**Root cause (suspected):** The `clear_output_and_history()` function in TUI:
1. Generates a new `chat_session_id` (e.g. `tui-{:x}`)
2. Clears the output buffer
3. But the actual message persistence happens AFTER the LLM response, in `persist_chat_messages()` using the `session_id` returned from the Rust response

**Next step:** Trace `session_id` flow from TUI → Rust → SQLite `persist_chat_messages()`.

**File to check:** `crates/memphis-operator/src/chat.rs` lines 266–276

### Bug 2: "rem~:0" (remaining_context_tokens ~ 0) appears on long conversations

**Symptom:** Status bar shows `ctx:32k · prs:high · rem~:0` after a few turns.

**Root cause (suspected):** Miscalculation in `derive_context_pressure_summary()`:

**File:** `crates/memphis-tui/src/app.rs` line 3936

```rust
let remaining_context_tokens = context_window_tokens.saturating_sub(usage.prompt_tokens);
```

**Problem:** `prompt_tokens` includes:
- System prompt (potentially 8k+ tokens)
- All 40 history messages
- Current input

But `context_window_tokens` is only the model's raw context window (e.g. 32k).

For a model with 32k context and `prompt_tokens = 31,500` (system + history), the result is `remaining = 500`, which rounds to `rem~:0`.

### Bug 3: Rust and TypeScript compaction systems are siloed

**Symptom:** TypeScript compaction summarizes old messages, but Rust TUI still loads raw 40 messages from SQLite — potentially exceeding context.

**Root cause:** The Rust chat layer (`chat.rs`) has no access to TypeScript overlays. It reads directly from SQLite using `load_chat_rows()` and does not integrate with `conversation-context-service.ts`.

---

## Key Code Locations

| What | File | Lines |
|------|------|-------|
| TUI `/clear` handler | `crates/memphis-tui/src/app.rs` | 820–843 |
| TUI `start_chat_task` | `crates/memphis-tui/src/app.rs` | 1016–1055 |
| TUI `switch_session` | `crates/memphis-tui/src/app.rs` | 1363–1395 |
| Rust `chat_with_stream` | `crates/memphis-operator/src/chat.rs` | 256–450 |
| Rust `load_chat_rows` | `crates/memphis-operator/src/chat.rs` | 2134–2180 |
| Rust `persist_chat_messages` | `crates/memphis-operator/src/chat.rs` | 2215–2260 |
| Context pressure derivation | `crates/memphis-tui/src/app.rs` | 3930–3955 |
| Compaction service | `src/gateway/conversation-context-service.ts` | 502–650 |

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `MEMPHIS_CHAT_MAX_MESSAGES` | 40 | Max messages loaded from SQLite per turn |
| `MEMPHIS_CHAT_MAX_STEPS` | ? | Max tool-call steps per turn |
| `MEMPHIS_CHAT_MAX_TOKENS` | ? | Max tokens for completion |
| `MEMPHIS_CONTEXT_WINDOW_TOKENS` | (model cap) | Override context window size |

---

## Reproduction Steps

1. Start Memphis TUI
2. Have a conversation that spans 30+ turns (each ~500-1000 tokens)
3. Observe status bar: `ctx:32k · prs:high · rem~:0`
4. Run `/clear`
5. Send another message
6. **Bug:** Still shows `rem~:0` or context pressure is still high

---

## Questions to Answer

- [ ] Does `/clear` actually start a new SQLite session row or does it keep writing to the same `session_id`?
- [ ] Is `prompt_tokens` in the usage telemetry counting system_prompt + history + current input?
- [ ] Does the compaction overlay ever reach the Rust layer?
- [ ] Is there a separate context limit separate from `chat_max_messages` for the actual LLM call?

---

## Tags

`bug` `context-window` `tui` `rust-chat` `compaction` `session-management`
