# Vault Recovery Runbook

When the vault refuses to decrypt at boot, the daemon enters one of two states: hard crash loop (pre-PR #5 — `validateProductionSafety` throws) or degraded boot (post-PR #5 — daemon survives, `/health.degradedConfig.reasons` lists what's missing). This runbook walks you from "what do I see in logs" to "vault recovered, daemon clean" in 15-30 minutes depending on the path you pick.

> **Important:** Stop before destructive commands. Run section 2 (Pre-flight) FIRST. Most of the panic-time-cost in recovery is regret over wiped state that turned out to be salvageable.

---

## 1) Symptoms

You're in this runbook if you see one of:

**A — daemon crash loop (pre-degraded-boot):**

```bash
journalctl --user -u memphis -n 50 --no-pager | grep -E "Production safety|Vault decrypt|crash"
# Expect:
#   [memphis-config] VAULT:<key> resolution failed: Vault entry decryption failed
#   [MISSING_ENV] Production safety check failed: MEMPHIS_API_TOKEN is required in production
#   memphis.service: Main process exited, code=exited, status=4/NOPERMISSION
#   memphis.service: Scheduled restart job, restart counter is at <N>   # <N> growing = crash loop
```

**B — daemon up, degraded (post-PR #5):**

```bash
curl -s http://127.0.0.1:3000/health | jq '.degradedConfig.reasons'
# Expect: array of strings like
#   ["MEMPHIS_API_TOKEN missing", "anthropic provider missing credentials"]
```

```bash
journalctl --user -u memphis -n 20 --no-pager | grep -E "config-degraded-boot|bootstrap.warning"
# Expect: [security-audit] config-degraded-boot allowed reasons=[...]
```

**C — tier-3 elevation lost after restart:**

```bash
curl -s http://127.0.0.1:3000/v1/ops/tier3/sessions
# Expect: {"count":0,...} even though you elevated before restart
# (Fixed in PR #566 — sessions now persist. If you see this on a post-#566 daemon,
#  it's a separate bug.)
```

**D — TUI banner:** `[degradation] provider 'minimax' is not configured ... falling back to local-fallback` — confirms degraded boot is active.

Pick a recovery path in section 3 based on what evidence you've gathered.

---

## 2) Pre-flight (before any recovery command)

```bash
# Confirm at least one usable backup exists
ls -la ~/Backups/memphis-pre-vault-recovery-* ~/Backups/vault-pre-reinit-* 2>/dev/null

# Confirm chain integrity is independent of vault state
sqlite3 ~/memphis/data/memphis.db 'PRAGMA integrity_check' 2>&1 | head -3
# Expect: "ok" — vault and chain DB are decoupled

# Snapshot doctor before recovery for diffing later
memphis doctor --json > /tmp/pre-recovery-doctor.json 2>&1 || true

# Capture current vault file mtimes (helps decide rollback target)
ls -la ~/.memphis/vault-*.json* 2>&1
```

> **Important:** Do NOT run `memphis reset --runtime --yes` or `memphis vault reset` before this section completes. Resetting before you confirm a backup directory exists is the operator-pattern that turned 30-minute incidents into 6-hour rebuilds.

> **Important:** Take a fresh local copy of `~/memphis/.env` to `/tmp/env-snapshot-$(date +%s)`. The recovery paths modify or replace `.env`; a clean copy of the current state is your bailout.

---

## 3) Recovery paths

Pick exactly one. They are mutually exclusive — running A then B leaves the vault in a state neither path tested.

### A) Plain-text bypass (degraded boot, fastest)

**Use when:** you have the original provider API keys + telegram tokens at hand AND want the bot back online in 5 minutes. Vault stays broken; clean up later via Path C when convenient.

```bash
systemctl --user stop memphis

# Replace VAULT:<key> references in .env with plain-text values
# You'll edit ~/memphis/.env directly:
#   MINIMAX_API_KEY=<paste-value>            (was VAULT:minimax_api_key)
#   MEMPHIS_TELEGRAM_BOT_TOKEN=<paste-value> (was VAULT:telegram_bot_token)
#   MEMPHIS_TELEGRAM_ALLOWED_USER_IDS=<csv>  (was VAULT:telegram_allowed_user_ids)

# Generate a fresh MEMPHIS_API_TOKEN if vault entry is gone
echo "MEMPHIS_API_TOKEN=$(openssl rand -hex 32)" >> ~/memphis/.env
# Then deduplicate the file — keep ONLY the latest MEMPHIS_API_TOKEN line

systemctl --user start memphis
sleep 5
curl -s http://127.0.0.1:3000/health | jq '.status'   # expect "healthy"
```

**Caveat:** API clients that used the old `MEMPHIS_API_TOKEN` (TUI sessions, external scripts) need to be re-authenticated with the new token. Tier-3 elevations are wiped (in-memory anyway, even with #566 persisted ones — vault re-init also clears state).

### B) Vault-state rollback (when backup tarball matches)

**Use when:** you have a pre-incident backup AND the pepper that was active at backup-time is known. This is fragile if you don't remember which pepper goes with which `vault-state.json` snapshot.

```bash
systemctl --user stop memphis

# Find the most recent good backup
ls -t ~/Backups/memphis-pre-vault-recovery-*/vault-state.json | head -1
# Example: ~/Backups/memphis-pre-vault-recovery-20260511-012600/vault-state.json

BACKUP_DIR=~/Backups/memphis-pre-vault-recovery-20260511-012600
cp $BACKUP_DIR/vault-state.json     ~/.memphis/vault-state.json
cp $BACKUP_DIR/vault-entries.json   ~/.memphis/vault-entries.json
cp $BACKUP_DIR/.env                 ~/memphis/.env

# Verify pepper from the backup matches what's in the restored .env
grep MEMPHIS_VAULT_PEPPER ~/memphis/.env

systemctl --user start memphis
sleep 5
journalctl --user -u memphis -n 20 --no-pager | grep -i "vault.*decrypt"  # expect no "failed" lines
```

> **Important:** If `journalctl` after restart still shows decrypt failures, the backup tarball's `vault-state.json` was written under a different pepper than the backup's `.env` records. Stop, go to Path C — iterative pepper guessing on a vault corrupts further on each wrong attempt.

### C) Clean re-init (destructive, recommended for production hygiene)

**Use when:** you don't trust the current vault state, you don't need to preserve encrypted entries, AND you have the API keys + recovery Q&A at hand to re-provision after init.

```bash
systemctl --user stop memphis

# Snapshot current vault aside (safety net)
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p ~/Backups/vault-pre-reinit-$TS
mv ~/.memphis/vault-state.json    ~/Backups/vault-pre-reinit-$TS/ 2>/dev/null || true
mv ~/.memphis/vault-entries.json  ~/Backups/vault-pre-reinit-$TS/ 2>/dev/null || true
mv ~/memphis/data/vault-entries.json ~/Backups/vault-pre-reinit-$TS/legacy-vault-entries.json 2>/dev/null || true

# Re-init with non-interactive flags (pick a fresh strong passphrase + Q&A)
cd ~/memphis
./bin/memphis init \
  --non-interactive \
  --state minimal-baseline \
  --passphrase '<strong-vault-passphrase>' \
  --operator-passphrase '<operator-tier3-passphrase>' \
  --recovery-question 'your question?' \
  --recovery-answer 'your answer'

# Re-provision provider API keys (vault is empty after init)
./bin/memphis vault add minimax_api_key     # paste value at prompt
./bin/memphis setup telegram --bot-token <token> --allowed-user-ids <csv>

# Optionally enable Anthropic
echo "ANTHROPIC_API_KEY=<value>" >> ~/memphis/.env

systemctl --user start memphis
sleep 8
curl -s http://127.0.0.1:3000/health | jq '.status, .degradedConfig'
```

> **Important:** This destroys all encrypted vault entries. Chains, SQLite, and operator config (passphrase hash, recovery Q&A) under `~/.memphis/config/` are untouched. If you have other secrets in the vault beyond minimax/telegram/anthropic, list them with `memphis vault list` BEFORE running this section.

---

## 4) Verification post-recovery

Run all four, in order. Each builds confidence; if any fail, return to the relevant section and re-do it.

```bash
# 1. Daemon health (no degradedConfig in steady state after Path C; expected in Path A until cleanup)
curl -s http://127.0.0.1:3000/health | jq '.status, .degradedConfig // "clean"'

# 2. Doctor green
memphis doctor 2>&1 | tail -5
# Expect: total=N pass=N warn=<low> fail=0

# 3. Tier-3 smoke (proves operator config intact)
# In TUI: /tier 3 <your-operator-passphrase>
# Expect: "Tier 3 granted — unrestricted mutation active for 3 hours"

# 4. Crash-loop watch — confirm we're not in a restart counter
journalctl --user -u memphis --since "5 minutes ago" --no-pager | grep -cE "Scheduled restart job"
# Expect: 0 (or 1 for the initial start). Numbers >1 mean still looping.
```

Diff against the pre-recovery snapshot:

```bash
diff <(jq -S '.' /tmp/pre-recovery-doctor.json) <(memphis doctor --json) | head -40
```

This surfaces what changed in the recovery — useful when you write up the postmortem note in `notes/`.

---

## 5) Prevention

The 2026-05-11 incident root cause was non-atomic `memphis vault pepper-rotate` — the master key in `vault-state.json` got re-wrapped under a new pepper but encrypted entries stayed under the old master key. That's fixed in [`feat/vault-pepper-rotate-reencrypt-entries`](https://github.com/Memphis-Chains/memphis/pulls?q=pepper-rotate-reencrypt) (Coder B's PR) and surfaced by the `ta3-pepper-rotate-atomic` doctor check.

Hygiene rules:

```bash
# ALWAYS backup before rotating pepper
memphis backup create --tag pre-pepper-rotate-$(date +%Y%m%d-%H%M%S)

# THEN rotate
memphis vault pepper-rotate --confirm --generate

# Verify atomicity post-rotate
memphis doctor 2>&1 | grep ta3-pepper-rotate-atomic
# Expect: pass
```

Cross-references:

- General backup workflow: [`OPERATIONS-MANUAL.md` § 2](OPERATIONS-MANUAL.md#2-backup--restore-workflows)
- Tier-3 destructive ops gating: [`tier3-runbook.md`](tier3-runbook.md)
- Force-flag bypass contracts (incl. `MEMPHIS_STRICT_PRODUCTION_SAFETY=1`): [`FORCE-FLAGS.md`](FORCE-FLAGS.md)
- Post-incident gap analysis (source of truth for the three paths above): [`../roadmap/2026-05-11-post-autonomy-todo-and-gap.md`](../roadmap/2026-05-11-post-autonomy-todo-and-gap.md) § 3
