# Bug 002: Cron Scripts — Telegram Not Sending

**Data:** 2026-05-14  
**Status:** 🟡 Fixes applied  
**Priority:** 🔴 High  
**Discovered via:** Scheduler debug session  

---

## Symptoms

Cron scripts scheduled in Memphis scheduler were NOT sending messages to Telegram. Scripts existed in `~/.memphis/scripts/` and `~/.memphis/crons/` but either:
1. Had silent failures (no Telegram message, no error visible)
2. Had syntax errors causing command-not-found

---

## Root Causes Found

### Bug A: `$CHAT_ID="1316033647"` — invalid variable declaration (2 scripts)

**Affected:** `deep-dive.sh`, `code-evolution.sh`

```bash
# BEFORE (ERROR)
$CHAT_ID="1316033647"   # bash: try to execute $CHAT_ID as command

# AFTER (FIXED)
CHAT_ID="1316033647"    # correct variable declaration
```

**Error in logs:**
```
STDERR: =1316033647: command not found
```

### Bug B: Wrong chain file path — `system.jsonl` (1 script)

**Affected:** `deep-dive.sh` line 30

```bash
# BEFORE (ERROR)
CHAIN_COUNT=$(wc -l < "$HOME/.memphis/chains/system.jsonl" 2>/dev/null || echo "?")

# AFTER (FIXED)
CHAIN_COUNT=$(ls "$HOME/.memphis/chains/system/"*.json 2>/dev/null | wc -l || echo "?")
```

**Error in logs:**
```
STDERR: /home/memphis/.memphis/scripts/deep-dive.sh: line 30: /home/memphis/.memphis/chains/system.jsonl: No such file or directory
```

System chain stores files as `000001.json` not `.jsonl`.

### Bug C: `telegram-insights-push.sh` NOT in Memphis scheduler

**Problem:** Script existed at `~/.memphis/crons/telegram-insights-push.sh` with schedule comment `# schedule: 0 */6 * * *` but was NEVER registered with the Memphis scheduler. No `memphis cron add` was ever run for it.

**Fix:** Added to `~/.memphis/config/scheduler/tasks.json` with cron `0 */6 * * *`.

---

## Fixes Applied

| File | Fix | Status |
|------|-----|--------|
| `~/.memphis/scripts/code-evolution.sh` | `$CHAT_ID=` → `CHAT_ID=` | ✅ Fixed |
| `~/.memphis/scripts/deep-dive.sh` | `$CHAT_ID=` → `CHAT_ID=` | ✅ Fixed |
| `~/.memphis/scripts/deep-dive.sh` | `chains/system.jsonl` → `chains/system/*.json` | ✅ Fixed |
| `~/.memphis/config/scheduler/tasks.json` | Added `telegram-insights-push` task | ✅ Fixed |

---

## Verification

Manual test of `ranny-raport.sh` → Telegram message #2104 ✅

```
ok: true
messageId: 2104
chatId: 1316033647
```

Scheduler run after fix:
- `deep-dive` 2026-05-14 06:00 — still had old system.jsonl error (pre-fix log), next run 08:00
- `code-evolution` 2026-05-14 10:00 — still had old error (pre-fix log), next run 14:00
- `ranny-raport-v2` 2026-05-14 05:00 → SUCCESS (message #2104)
- `telegram-insights-push` — added to scheduler, first run should be ~12:00

---

## Scheduler Tasks After Fix

```
shell-moenwgoh  | 0 8 * * * | memphis-deep-dive-telegram
shell-moenwjud  | 0 */4 * * * | memphis-code-evolution-telegram  
shell-mp3ln280  | 0 7 * * * * | ranny-raport-v2
shell-tginspush | 0 */6 * * * | telegram-insights-push  ← NEW
```

---

## Questions

- [ ] `daily-todo-archive` task disabled — should it be re-enabled?
- [ ] Are there other Memphis scripts with the `$VAR=` bug pattern?

---

## Tags

`bug` `cron` `telegram` `bash` `scheduler` `memphis`

---

## Additional Findings (2026-05-14 ~14:30)

### Bug D: Wrong script path — absolute path with `memphis/` prefix

**Problem:** Added task with path `/home/memphis/memphis/crons/telegram-insights-push.sh` but the actual Memphis home is `/home/memphis/.memphis/` (not `/home/memphis/memphis/`).

**Correct paths:**
- Scripts: `/home/memphis/.memphis/scripts/`
- Crons: `/home/memphis/.memphis/crons/` (NOT `/home/memphis/memphis/crons/`)

The Memphis user home is `~ = /home/memphis/`, and Memphis data is in `~/.memphis/` = `/home/memphis/.memphis/`.

### Bug E: `nextRun = null` — task never scheduled

**Problem:** When task was added, `nextRun` was left as `null`, so Memphis scheduler couldn't compute when to run it.

**Fix:** Set `nextRun = '2026-05-14T18:00:00.000Z'` (next 6-hour interval).

### Current scheduler state

| Task | Enabled | nextRun | lastRun |
|------|---------|---------|---------|
| `shell-moenwgoh` deep-dive | ✅ | 2026-05-15 06:00 | 2026-05-14 06:00 |
| `shell-moenwjud` code-evolution | ✅ | 2026-05-14 14:00 | 2026-05-14 10:00 |
| `shell-mp3ln280` ranny-raport | ✅ | 2026-05-15 05:00 | 2026-05-14 05:00 |
| `shell-tginspush` insights | ✅ | 2026-05-14 18:00 | **None (never ran)** |

**Expected first run of telegram-insights-push:** ~18:00 UTC today.
