# Memphis Session Handoff — 2026-05-11

**Started:** 2026-05-11 ~17:00 CEST (cascade planning)
**End of active work:** 2026-05-11 ~20:00 CEST
**Last operator signal:** "zapisujemy prace, rozumiemy co pozostaje"

---

## 1. What landed today (✅ done)

### PR cascade — 7 PRs merged to main (~30 min wallclock, parallelized CIs)

| PR | Squash on main | What it ships |
|---|---|---|
| #569 | `8126277d` | CI audit gate allowlist for OTEL prometheus exporter advisory (GHSA-q7rr-3cgh-j5r3) |
| #566 | `6b58f964` | Tier-3 session persistence hardening: TTL clamp (both bounds) + fsync before rename + symlink defense + tier3-hydrate audit event + hydrate-timer reschedule + rawEnv threading + path-leak fix |
| #562 | `ea6bd2a1` | Doctor whitelist `~/.memphis/docs/` as known dir |
| #565 | `9c7bc6de` | Holistic audit + refactor roadmap doc (docs-only) |
| #567 | `cd398946` | Operator-facing VAULT-RECOVERY-RUNBOOK + RUNBOOK.md index entry |
| #568 | `133f533a` | Graceful degraded boot on missing vault secrets (Anthropic in providerRequirements + degraded-by-default + opt-in strict via MEMPHIS_STRICT_PRODUCTION_SAFETY) |
| #570 | `3703ca91` | Provider auto-failover on stream timeout (cascade walker + isTimeoutLikeError whitelist + failover stamp + audit event) |

All 7 branches deleted from origin. Cross-reviews completed (LGTM on #566 + #569).

### Production fix activated

- `.env` edited: `DEFAULT_PROVIDER=anthropic` (later reverted to `minimax` externally) + `GEN_TIMEOUT_MS=300000` (later reverted to `45000` externally) + cascade reorder
- `git pull --ff-only && npm run build && memphis service restart && memphis providers health` — daemon ran on Anthropic Opus 4.6, 4 providers healthy
- `memphis doctor --fix --apply` — orphan files cleaned (3 moved to `~/.memphis/backups/orphans-*`)
- `git config --global pull.rebase true` — cron task-1777576880613 (git-pull-and-build) no longer blocked on divergent branches
- Chain corruption fix: `cases/001137.json` quarantined to `~/Backups/memphis-corrupt-blocks-*/` (was the "Extra data line 14" parse failure Memphis Agent reported at 19:11)
- `~/.memphis/chains/cases.backup-1777572129840` + `patterns.quarantine-2631-2645` moved to backups (were tripping first-run scanner)
- Doctor went `legacy-manual` → PASS (`initialized via legacy-repair`)
- Env flips added: `MEMPHIS_EMBED_DISK_V2=1`, `RUST_EMBED_PERSIST_PATH=/home/memphis/memphis/data/embed-index.json` (doctor sees 772 vectors now), `MEMPHIS_ANTICONFAB_PHASE=3` (strip-sentence mode)
- Embed-index sync from `/home/memphis/data/embed-index.json` (12 MB canonical) → `/home/memphis/memphis/data/embed-index.json` (daemon was reading empty 33-byte file because of cwd/install-root path bug)

### Memphis Agent runtime
- Switched from MiniMax (stream timeouts on 88k+ context) to Anthropic Opus 4.6
- Tier-3 re-elevated post-restart (`/tier 3 <passphrase>`)
- Doctor PASS 45/13/0 (best state of the session)

---

## 2. What broke + how it was recovered

### ✅ Daemon RECOVERED 23:06 CEST via Path 1 (pepper revert)

`MEMPHIS_VAULT_PEPPER` was reverted from test-fixture `sufficientlyLongPepper999` (25 chars, weak) back to `memphis-b1435805c407dff3417ee62b51e4136a` (40 chars, strong — original). Path 1 worked first-try: vault decrypted, daemon started, providers all healthy.

Lesson: when `.env` pepper changes externally and vault entries stay encrypted under the old pepper, **Path 1 (revert pepper) is the 5-second fix** before considering vault state rollback or wipe. Already captured in `memory/feedback_pepper_desync_twice_same_day.md`.

### 🚨 Original incident (kept for postmortem)

`.env` was modified externally at 19:54:55 — `MEMPHIS_VAULT_PEPPER` changed from strong (40 chars) to weak test fixture (25 chars). Vault entries (minimax/telegram/brave) encrypted with OLD pepper. Daemon refused to start with `Vault state cannot decrypt 3 of 3 entries` integrity probe failure (exit code 102).

`.env` was modified externally at 19:54:55 — `MEMPHIS_VAULT_PEPPER` changed from `memphis-b1435805c407dff3417ee62b51e4136a` (40 chars, strong) to `sufficientlyLongPepper999` (25 chars, weak — looks like test fixture). Vault entries (minimax/telegram/brave) encrypted with OLD pepper. Daemon refuses to start with `Vault state cannot decrypt 3 of 3 entries` integrity probe failure (exit code 102).

**This is the SECOND vault desync today.** First was 01:20 CEST (post pepper-rotate). Both incidents have the same root cause: pepper-rotate is NOT atomic — re-wraps master key without re-encrypting entries. Coder B's P1 #4 PR (`fix/vault-pepper-rotate-reencrypt-entries`) was supposed to fix this but **was never pushed**.

Recovery executed by Memphis Agent (this Claude Code) on operator command "naprawiamy daemon":
- **Path 1 executed** ~23:06 CEST — `sed` replaced pepper in `.env` → `memphis service restart` → daemon active in 3 sec → vault encrypt/decrypt cycle ✓.

Daemon now live on minimax (per .env DEFAULT_PROVIDER), all 4 providers reachable (anthropic 13ms, ollama 5ms, local-fallback 1ms, minimax 0ms).

---

## 3. Broad-perspective queue — what remains

### CRITICAL — fixes the actual root cause

- **Coder B's vault pepper-rotate atomic re-encrypt (P1 #4)** — never pushed despite multiple prompts. The pattern of two-incidents-in-one-day on the same vector means this is now **the highest-priority engineering item** for the next session. Without it, every pepper change risks repeating today's daemon-down state.

### HIGH — Memphis stability + memory integrity

- **Memory chain recall debug** — Memphis Agent reported (19:11) `memphis_soul_read` returns null + `001137.json` corrupted (now quarantined — that one's fixed) + no project history in journal recall. Soul-empty + journal-recall-gap are still open. May require chain rebuild from system+journal merge or new chain hydrate path.
- **Insights chain blocks too large** — reindex skips 37 blocks ≥4096 bytes (`embed_store_failed: text too large`). P1.B "embed chunker" from holistic audit roadmap addresses this. Would unblock semantic search over large insights.
- **Memphis confab pattern** — even after Phase 3 strip-sentence enable, Memphis kept producing false-alarm claims (git unset, vault broken, "jestem sparaliżowany") when state was actually fine. Operator dropped my `notes/memphis-agent-reality-check-2026-05-11.md` reality-check delivery path. Confab detection may need different surface (e.g., pre-send verification probes).
- **TUI Rust panic at ~128k context** — `attempt to subtract with overflow` at `<file>.rs:1129:29` (path truncated in operator paste). Separate Rust crate bug, needs source location identified.

### MEDIUM — UX gaps Memphis itself surfaced

- **Telegram media bridge** — Whisper STT :9000 + Piper TTS :5500 are up but Telegram handler doesn't call `memphis_media_ingest` on incoming voice. Memphis-initiated request at 17:14, follow-up at 19:09. Likely small TS PR in `src/gateway/channels/telegram.ts`.
- **Voice reply via Piper** — operator-side mention; pairs with media ingest.
- **Vision wiring** — moondream model up but no Telegram photo handler. Same pattern.
- **Brave Search integration** — operator chose option 1 (vault entry + web_fetch tool with X-Subscription-Token header) but key never added to vault, tool wiring never shipped.
- **Anti-confab Phase 3 enabled now** (`MEMPHIS_ANTICONFAB_PHASE=3`) — needs 1-2 days observation; rollback to 2 (warn-append) if false-positive rate is operator-visible noisy.

### LOW — housekeeping

- **PR #563 can be closed** — content (training-anthropic-window-* docs) is in main via #566 squash side-channel (rebase pulled `91383912` into the squash). Operator comment with "merged via #566" is enough.
- **PR #564 kartograf v4 DeBERTa** — overnight training timer 23:00 CEST fires independently. Operator decision whether to merge.
- **Demo readiness** — `memphis demo arm` only before live session.
- **Recovery Q&A** — `memphis operator set-passphrase --recovery-question … --recovery-answer …` only if operator wants passphrase recovery option.
- **Alert transport** — PagerDuty/OpsGenie only if external paging needed.
- **MCP server :3001** — informational, only if MCP clients need to connect.
- **Multi-agent sync / External plugin** — informational, future scope.
- **Kartograf checkpoint install** — overnight timer at 23:00 will populate.
- **Cron task-1777576880613 (morning-raport-wodzu)** — re-armed today with passphrase, next fire 5/12 10:00 — should clear doctor warn naturally if no further issues.

### STRATEGIC — operator-decision items from holistic audit roadmap (PR #565)

- **P1.E** — Memphis self-modify on Rust crates (currently TS-only — extends current scope)
- **P2.F** — memphis_external_write tool for tier-3 outside `~/memphis/`
- **Y1 Q3+ vision** — multi-host federation, plugin marketplace, cross-modal cognition, continuous fine-tuning loop

---

## 4. Lessons captured in memory (next-session benefit)

- Multi-agent role-label confusion — both agents called themselves "Coder A" until we synced via handoff file. Always disambiguate via explicit per-PR ownership table.
- Plan-agent verification — both agents' `Plan` agents made minor errors (incorrect file path memory, unnecessary defense-in-depth guards). Cross-review caught both. Don't trust Plan output blindly.
- Stacked-PR squash gotcha replay — even drugi koder hit it twice (#567 + #570) because local `main` was ahead of origin. Always base off `origin/main` explicitly, not local.
- Install-root anchoring affects MORE than CLI handlers — embed-index.json default path (`./data/embed-index.json`) resolves to different dirs depending on daemon cwd, causing read/write split. Doctor needs `RUST_EMBED_PERSIST_PATH` set explicitly.
- Vault pepper desync = repeated incident = real architectural fix needed. P1 #4 is now P0 priority.

---

## 5. Files this session created (untracked, operator decides what to keep)

- `.claude/handoff-vault-recovery.md` (this file)
- `notes/memphis-agent-reality-check-2026-05-11.md` (delivered-but-Memphis-didn't-read)
- `/home/memphis/.claude/plans/joyful-jumping-dove.md` (autopilot plan, executed)

All gitignored per `feedback_local_artifacts_never_stage.md` policy.

---

## 6. Daemon recovery checklist (when operator returns)

```bash
# 1. Decide pepper recovery path (1/2/3/4 from previous turn)
#    Default recommendation: try Path 1 (revert pepper) first
sed -i 's/^MEMPHIS_VAULT_PEPPER=.*/MEMPHIS_VAULT_PEPPER=memphis-b1435805c407dff3417ee62b51e4136a/' ~/memphis/.env

# 2. Restart
memphis service restart

# 3. Verify
journalctl --user -u memphis -n 5 --no-pager | grep -iE "started|integrity"
memphis doctor 2>&1 | grep -E "Summary|Vault encryption"

# 4. If Path 1 fails → Path 2 (restore vault-state.json.bak) or Path 3 (wipe + re-init)
```

After daemon recovers:
- `memphis tui` → re-elevate `/tier 3 <passphrase>`
- Doctor should return to PASS 45/13/0 (or better with the embed-v2 + anti-confab Phase 3 flips still in place)
