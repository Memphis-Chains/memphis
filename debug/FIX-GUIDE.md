# Memphis Bugs — Coder Fix Guide

**Data:** 2026-05-14  
**Status:** 🟡 Ready to fix  
**Dla koderów:** Codex, Claude, etc.

---

## BUG-001: Context Window & Session Management

### Location
- `crates/memphis-tui/src/app.rs` lines 820–843, 3930–3955
- `crates/memphis-operator/src/chat.rs` lines 266–276, 2215–2260
- `src/gateway/conversation-context-service.ts` (TS compaction)

### Symptom
Status bar shows `ctx:32k · prs:high · rem~:0` after a few turns. The 32k value was STALE — MiniMax M2.7 supports 204,800 tokens.

### What Works (confirmed NOT a bug)
- `/clear` correctly creates new SQLite session ✅
- `remaining_context_tokens` formula is correct ✅  
- Context window for MiniMax M2.7 = 204,800 ✅ (fixed in commit `fc2a02f6`)

### What Needs Investigation
**The `rem~:0` on long conversations** — when it appears, need to check:
1. Is `live_token_usage` being fed from mid-stream Usage events or final exchange?
2. Is the TUI correctly picking up MiniMax's 204,800 context (not defaulting to Ollama 8k)?

### Files to Review
```rust
// crates/memphis-tui/src/app.rs:3853-3880
fn selected_model_capability() // ← Verify MiniMax model matching works

// crates/memphis-tui/src/app.rs:3930-3955  
fn derive_context_pressure_summary() // ← Formula is correct, check input values
```

---

## BUG-002: Cron Scripts Not Sending to Telegram

### Locations & Fixes

#### Fix 1: `$CHAT_ID=` → `CHAT_ID=` (2 files)
**Bug:** Variable declared as `$CHAT_ID="1316033647"` — bash tries to execute `$CHAT_ID` as a command.

**Files:**
- `~/.memphis/scripts/code-evolution.sh` line 8
- `~/.memphis/scripts/deep-dive.sh` line 8

**Fix:**
```bash
# BEFORE
$CHAT_ID="1316033647"   # WRONG

# AFTER  
CHAT_ID="1316033647"    # CORRECT
```

#### Fix 2: Wrong chain file path (1 file)
**Bug:** Script references `$HOME/.memphis/chains/system.jsonl` — chain uses `.json` files, not `.jsonl`.

**File:** `~/.memphis/scripts/deep-dive.sh` line 30

**Fix:**
```bash
# BEFORE
CHAIN_COUNT=$(wc -l < "$HOME/.memphis/chains/system.jsonl" 2>/dev/null || echo "?")

# AFTER
CHAIN_COUNT=$(ls "$HOME/.memphis/chains/system/"*.json 2>/dev/null | wc -l || echo "?")
```

#### Fix 3: `telegram-insights-push.sh` not in Memphis scheduler
**Bug:** Script existed at `~/.memphis/crons/telegram-insights-push.sh` but was NEVER added to the Memphis scheduler (`~/.memphis/config/scheduler/tasks.json`). The schedule comment `# schedule: 0 */6 * * *` was just a comment — no `memphis cron add` was ever run.

**Add to scheduler tasks.json:**
```json
{
  "id": "shell-tginspush",
  "cron": "0 */6 * * *",
  "name": "telegram-insights-push",
  "command": {
    "type": "shell",
    "script": "/home/memphis/memphis/crons/telegram-insights-push.sh"
  },
  "enabled": true,
  "nextRun": "2026-05-14T18:00:00.000Z"
}
```

#### Fix 4: WRONG path in scheduler task (FIXED)
**Bug:** Memphis DATA dir is `~/.memphis/` (not `~/.memphis/.memphis/`). Memphis REPO dir is `~/memphis/`.

**The confusion:**
```
~/.memphis/    = DATA dir (scheduler, scripts, vault, chains)
~/memphis/    = REPO dir (source code, crons, dist)
```

**Important:** Scripts in `~/memphis/crons/` (REPO) must use absolute paths, NOT `~/.memphis/`.

---

## Quick Reference: Memphis Directory Structure

```
/home/memphis/               ← Memphis Git repo (~/memphis/)
├── memphis/crons/           ← Cron scripts (absolute path: /home/memphis/memphis/crons/)
├── memphis/scripts/         ← Custom scripts
└── ...

/home/memphis/.memphis/     ← Memphis data dir (~/.memphis/)
├── scripts/                 ← Custom scripts  
├── crons/                   ← ❌ DOES NOT EXIST (wrong path used in bugs)
├── config/scheduler/         ← Scheduler tasks.json
├── chains/                  ← Chain data (JSON files, NOT .jsonl)
└── vault/                   ← Secrets
```

---

## Scheduler Task Checklist

When adding a new cron task:
1. ✅ Use absolute path `/home/memphis/memphis/crons/script.sh` (NOT `~/.memphis/crons/`)
2. ✅ Compute `nextRun` from cron expression (don't leave `null`)
3. ✅ Add to `~/.memphis/config/scheduler/tasks.json`
4. ✅ Test manually: `bash /home/memphis/memphis/crons/script.sh`

---

## Scripts to Audit for `$VAR=` Bug

```bash
grep -rn '^\$[^ ]*=' /home/memphis/.memphis/scripts/ 2>/dev/null
grep -rn '^\$[^ ]*=' /home/memphis/memphis/crons/ 2>/dev/null
```

Pattern to fix: lines starting with `$` followed by variable name and `=` — should be `VAR=value` not `$VAR=value`.

---

## Verified Working Scheduler Tasks

```json
[
  {"id": "shell-moenwgoh", "cron": "0 8 * * *", "name": "memphis-deep-dive-telegram"},
  {"id": "shell-moenwjud", "cron": "0 */4 * * *", "name": "memphis-code-evolution-telegram"},
  {"id": "shell-mp3ln280", "cron": "0 7 * * *", "name": "ranny-raport-v2"},
  {"id": "shell-tginspush", "cron": "0 */6 * * *", "name": "telegram-insights-push"}
]
```

---

## Tags

`bug` `cron` `telegram` `bash` `scheduler` `memphis`