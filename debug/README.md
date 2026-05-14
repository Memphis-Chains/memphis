# Memphis Debug Directory

Bug reports and investigation notes for Memphis.

## Files

| File | Status | Description |
|------|--------|-------------|
| `BUG-001-context-session-management.md` | 🟡 Investigating | Context window, `/clear`, `rem~:0` |
| `BUG-002-cron-scripts-telegram.md` | ✅ Fixes applied | Cron scripts not sending to Telegram |

---

## Quick Index

### BUG-001: Context Window & Session Management (🟡 Investigating)

**Symptoms:** `ctx:32k · prs:high · rem~:0` after a few turns.

Key findings:
- `/clear` works correctly ✅
- MiniMax M2.7 context = 204,800 tokens ✅ (was 32k before fix `fc2a02f6`)
- `remaining_context_tokens` formula correct ✅
- `rem~:0` still unexplained — needs live reproduction

### BUG-002: Cron Scripts — Telegram Not Sending (✅ Fixed 2026-05-14)

**Root causes found:**
1. `$CHAT_ID="1316033647"` invalid syntax in `deep-dive.sh` + `code-evolution.sh`
2. `system.jsonl` wrong path in `deep-dive.sh` (chain uses `.json` files)
3. `telegram-insights-push.sh` never added to Memphis scheduler

**Fixes applied:**
- Fixed `$CHAT_ID=` → `CHAT_ID=` in both scripts
- Fixed `system.jsonl` → `chains/system/*.json`
- Added `telegram-insights-push` to scheduler (`0 */6 * * *`)

---

## Session History

### 2026-05-14 — Cron Telegram debug

- Memphis scheduler running (30s polling interval)
- 5 tasks in scheduler (1 disabled, 4 active)
- Found 3 bugs in cron scripts
- All fixed, verified `ranny-raport.sh` sends to Telegram (msg #2104)
- Created BUG-002

### 2026-05-13 — Context window investigation

- Found two independent chat systems (Rust TUI vs TypeScript gateway)
- SQLite analysis: 17 sessions, 4387 total messages
- Verified `/clear` works, MiniMax 204k context
- Created BUG-001 + `debug-session` skill

---

## How to Continue

```bash
# Check scheduler logs
tail -5 ~/.memphis/config/scheduler/logs/shell-moenwjud.log

# Check Telegram cron
ls ~/.memphis/cron-logs/

# Check what cron is scheduled
cat ~/.memphis/config/scheduler/tasks.json

# Check for $VAR= bugs in all scripts
grep -rn '^\$[^ ]*=' ~/.memphis/scripts/ ~/.memphis/crons/ 2>/dev/null
```
