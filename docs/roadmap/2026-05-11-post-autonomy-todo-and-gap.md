# Post-Autonomy TODO + Gap Analysis — 2026-05-11

**Generated:** 2026-05-11 ~01:30 CEST, end of 17-PR autonomy unblocking sweep + immediate-aftermath vault incident.
**Status:** Daemon stopped (was in crash loop, killed manually). Bot offline. Recovery + roadmap pending.
**Backup point:** `~/Backups/memphis-pre-vault-recovery-20260511-012600/` (67M — vault + .env + chains + SQLite + config).

---

## 1. Today's commits vs Plan `agile-nibbling-feigenbaum.md` (gap analysis)

**Plan said:** 6 phases. **Today (2026-05-10 + 2026-05-11):** 35 commits, 17 PRs merged, 1 PR open (#562).

### Phase 1 — Embed bulk + NDJSON v2
- **Planned:** Single PR Rust + NAPI + TS + reindex caller + format upgrade
- **Shipped:** `8c134a48` (Merge `fix/embed-bulk-flush-ndjson-v2`)
- **Status:** ✓ DONE per plan

### Phase 2 — Anthropic prompt caching + 128k
- **Planned:** Single PR — caching + token bump bundled
- **Shipped:** `d1359963` (Merge `feat/anthropic-cache-128k`) + `06ad7463`
- **Status:** ✓ DONE per plan

### Phase 3 — Anti-confab Phase 2 warn-append
- **Planned:** Small isolated PR with footer warning + soft-evidence phrase list
- **Shipped:** `545f6819` (Merge `feat/anti-confab-phase-2`) + `e5d3c073`
- **Status:** ✓ DONE per plan

### Phase 4 — SyncManager atomicity + hybrid recall
- **Planned:** Two PRs (independent code paths) for atomic writeChain + restore exact-search
- **Shipped:** Nothing today — doctor `ta3-hybrid-recall` already passes (`canonical recall is semantic memphis_recall + exact memphis_search (FTS5)`), SyncManager already atomic (`writeChain() uses atomic locking`)
- **Status:** ✓ ALREADY CLOSED PRE-SESSION (plan was outdated)

### Phase 5 — Doctor easy-wins
Per plan: 8 sub-steps. Actual status:

| # | Step | Status | Commit/PR |
|---|---|---|---|
| 1 | Pepper rotation | ⚠ **REGRESSION** — see Section 3 | (cwd-bug remediation in `3b0a12d5`, `c06238dc`) |
| 2 | Demo arm refresh | ❌ pending operator | — |
| 3 | Cron task-1777576880613 | ⏳ self-heal scheduled 2026-05-11T08:00 UTC (10:00 CEST) | `2fb359ed` (ff-only fix) |
| 4 | Orphan files sweep | ⚠ `doctor --fix` would delete operator brief | PR **#562** open (whitelist `docs`) |
| 5 | Recovery Q&A | ❌ pending operator | — |
| 6 | MCP server :3001 | ❌ not addressed (intended as opt-in) | — |
| 7 | Voice STT/TTS | ✓ Piper systemd live, ⏳ Whisper waits operator `apt install python3-venv` | `96338c66`, `d3231632` |
| 8 | Provider cascade | ✓ DONE — `fallbackProvider: 'ollama'` (not stub) | `57c6624b` |

### Phase 6 — Autonomous self-modify smoke test
- **Planned:** Operator-supervised runtime task (no PR)
- **Status:** ❌ NOT RUN — pending operator decision

### Outside-plan PRs shipped (reactive fixes):
- TUI 110% CPU throttle (`cccf1b65`) — operator-reported same-day incident
- MiniMax overflow render (`029a0d95`, `e82d0154`) — operator UX complaint mid-session
- Anthropic Opus 4.6 default + 4.7 fallback (`9786f9c0`) — model preference applied
- Anthropic whitespace text-block guard (`810f0ab6`) — TUI 400 fix
- Doctor PROJECT_ROOT walk (`257d2fb4`), CLI handlers cwd→install-root (`3b0a12d5`, `c06238dc`), mode-dispatch token cap (`61a7d4f1`)
- Docs: `053c514b` (DAILY-ASSISTANT-SETUP.md), `4696f573` (agent operational patterns), `d3231632` (full Memphis recon = 3 maps)
- Install prereqs: `7f85f184` (python3-venv + tesseract-ocr)

### Critical missed (vault layer breakage)
**Not in original plan, surfaced 2026-05-11 ~01:20 CEST:**

- `MEMPHIS_API_TOKEN` missing entry kills daemon (`Production safety check failed`)
- Vault entries (`minimax_api_key`, `telegram_bot_token`, `telegram_allowed_user_ids`) decrypt-fail because `.env` MEMPHIS_VAULT_PEPPER is OLD-style (`pepper-Vault-Operator-local-2026-04-12-strong`) while `vault-state.json` was rewrapped with NEW-style pepper during today's pepper-rotate
- Daemon crash loop hit 63 restarts before manual stop
- Tier-3 elevation lost mid-session even with correct passphrase (likely related to pepper conflict)
- `crons/morning-report.sh` (AM staged + modified) — operator WIP from earlier session, not from today

---

## 2. TODO — to be addressed (priority-ordered)

### P0 — Bot offline (block production)
1. **Recover vault OR plain-text bypass** — operator decision pending. See Section 3.
2. **Provision `MEMPHIS_API_TOKEN`** — current .env line 7 is `VAULT:memphis_api_token` but that vault entry doesn't exist. Either:
   - (a) Generate random `MEMPHIS_API_TOKEN=$(openssl rand -hex 32)` → write plain to .env (operator API clients will need re-auth with new token)
   - (b) Restore from `.env.bak-pre-pepper-fix-1778420185` (May 10 15:36) which may contain the previously-working plain token
3. **Restart daemon clean** after #1+#2

### P1 — Production safety net (next 24h)
4. **`fix(vault): pepper-rotate must re-encrypt entries`** — root cause of today's incident. Pepper-rotate flow re-wrapped master key in `vault-state.json` but didn't iterate entries and re-encrypt them with the new master key. Need single PR adding the re-encrypt step after rotation, with test gate.
5. **`fix(config): missing vault entry should not crash daemon`** — production safety check should distinguish "secret missing" from "secret unconfigured intentionally" (e.g. when daemon should boot in degraded mode for diagnosis). Currently MEMPHIS_API_TOKEN missing → hard exit 4, no recovery hint.
6. **`docs(operator): vault-recovery RUNBOOK`** — first-time documented path for what to do when pepper-rotate leaves vault inconsistent. Currently operator had to do detective work + plain-text bypass without a guide.

### P2 — Fresh install validation path
7. **`tests/integration/fresh-install-smoke.test.ts`** — automated test that:
   - Spawns a temp `MEMPHIS_HOME=$tmpdir`
   - Runs `memphis init` + onboarding flow
   - Asserts daemon starts, doctor exits 0
   - Asserts Telegram/TUI surfaces wire correctly
   - Asserts vault create+store+rotate cycle works end-to-end
8. **`scripts/fresh-install-test.sh`** — local script (operator-runnable) that does same in `/tmp/memphis-test-$ts/`, prints pass/fail summary, cleans up. Bridge between unit tests and full e2e.
9. **`docs/operator/FRESH-INSTALL-VERIFICATION.md`** — step-by-step manual smoke test the operator runs after every major release. Pairs with `CLEAN-INSTALL.md` (which is install instructions, not verification).

### P3 — Operator-pending (manual)
10. Operator: `sudo apt install python3-venv && bash scripts/voice-install.sh` → Whisper :9000 live
11. Operator: `memphis vault init` → recovery Q&A interactive
12. Operator: `memphis demo arm` if live session planned
13. Operator: hot-restart TUI session (Ctrl+C + `memphis tui`) → CPU 110%→55% live
14. Operator: merge PR #562 (1-line doctor docs whitelist)
15. Operator: decide what to do with `crons/morning-report.sh` (AM staged from earlier session)

### P4 — Plan completion
16. Phase 6 — Autonomous self-modify smoke test (operator-supervised, runtime, no PR)

### P5 — Roadmap items surfaced today
17. **NDJSON v2 default flip** (Phase 1 follow-up) — env gate `MEMPHIS_EMBED_DISK_V2=1` currently default OFF. After 1 green rebuild session, flip default to 1.
18. **Cache-stability test** (Phase 2 follow-up) — Anthropic prompt caching depends on byte-identity of system prompt across calls. Need standing unit test that builds prompt 2x and asserts byte-equality. Currently relies on implicit determinism.
19. **Anti-confab Phase 3** (Phase 3 follow-up) — strip-sentence mode (env `MEMPHIS_ANTICONFAB_PHASE=3`) implemented but opt-in only. Decide after 1-2 weeks Phase 2 data whether to default-flip.

---

## 3. Vault incident — recovery options

**Symptom:** `~/memphis/.env:8` has `MEMPHIS_VAULT_PEPPER=pepper-Vault-Operator-local-2026-04-12-strong` (OLD), `~/.memphis/vault-state.json` (May 10 15:30, POST rotate) wrapped with NEW pepper. Three vault entries (`minimax_api_key`, `telegram_bot_token`, `telegram_allowed_user_ids`) won't decrypt.

**Cause hypothesis:** Today's `memphis vault pepper-rotate` had cwd-bug (wrote new pepper to `$HOME/.env` instead of `~/memphis/.env`). Manual remediation wrote NEW pepper to `~/memphis/.env`. Subsequent operation (operator action OR another bot session) reverted `~/memphis/.env` back to OLD pepper without realizing `vault-state.json` was already NEW-pepper-wrapped. Pepper-rotate also doesn't re-encrypt entries (separate bug — see P1 #4 above).

**3 recovery paths:**

**A. Plain-text bypass (fastest, operator already approved direction "daj minimax i restart"):**
- Operator hands me MINIMAX_API_KEY + MEMPHIS_TELEGRAM_BOT_TOKEN + MEMPHIS_TELEGRAM_ALLOWED_USER_IDS values from secure storage
- I write plain text to `~/memphis/.env`, generate random `MEMPHIS_API_TOKEN`
- Restart daemon → bot boots on MiniMax, vault stays broken until Path C
- ETA: 5 min once operator provides values

**B. Vault state rollback (if backup matches):**
- Restore `~/.memphis/vault-state.json.bak.1777298533134` (Apr 27 16:02) to `vault-state.json`
- Find which pepper that vault-state was wrapped with (try OLD pepper from current .env, then peppers from .env.bak files: `memphis-88ce07c2216bc5c842f52adbafd06070` in Apr 25 backup)
- Iterative trial — risk of further corruption if wrong attempt overwrites state
- ETA: 30-60 min, possible dead end

**C. Re-create vault (clean slate, recommended for production fresh install):**
- Move current vault aside: `mv ~/.memphis/vault-{state,entries}.json ~/Backups/.../`
- `memphis vault init` — fresh master key, fresh pepper
- `memphis provider add minimax --api-key <value>`, telegram-token, telegram-user-ids
- Operator's API clients need re-auth (random new MEMPHIS_API_TOKEN)
- ETA: 15 min, no risk to existing chain/SQLite data (only vault wiped)

**Recommendation:** **Path C** for production cleanliness. Path A as immediate boot if operator wants tonight. Path B too risky without strong signal which pepper matches Apr 27 backup.

---

## 4. Backup manifest — `~/Backups/memphis-pre-vault-recovery-20260511-012600/`

```
67M total
├─ .env                                  (May 11 01:20 — OLD pepper, currently broken)
├─ .env.bak-pre-pepper-fix-1778420185    (May 10 15:36 — pre-fix state)
├─ .env.bak-pre-pepper-rotate-20260509-000606  (May 9 00:06 — pre-rotate state)
├─ .env.bak.1777124338                   (Apr 25 — old pepper `memphis-88ce07c...`)
├─ .env.example                          (template for fresh install)
├─ vault-state.json                      (May 10 15:30 — NEW pepper wrapped)
├─ vault-state.json.bak.1777298533134    (Apr 27 16:02 — pre-rotate)
├─ vault-entries.json                    (Apr 26 12:42 — canonical path, pre-rotate)
├─ vault-entries-data.json               (May 10 14:02 — legacy path, post-rotate)
├─ memphis-data/
│  ├─ memphis.db                         (SQLite — sessions, FTS5)
│  └─ vault-entries.json                 (legacy daemon-read path)
├─ memphis.db                            (~/.memphis/ SQLite)
├─ case-index.sqlite                     (FTS5 case index)
├─ did.json                              (identity)
├─ chains/                               (9 chains, 6500+ blocks — irreplaceable)
└─ config/
   ├─ soul-manifest.json                 (tier-3 hash + autonomy rules)
   ├─ soul-memory.json                   (operator profile + learnings)
   ├─ agent-profile.json
   └─ scheduler/                         (6 cron tasks + logs)
```

**Recovery from this backup is non-destructive** — `cp` back to source paths restores last-known state. Chains + SQLite untouched throughout incident.

---

## 5. Resume snapshot for next session

When you (or next-session Claude) pick up:

1. **Read this doc** first — it captures everything in-flight.
2. **Daemon state:** stopped (`systemctl --user stop memphis` issued 2026-05-11 ~01:21). Don't start until vault path chosen (Section 3).
3. **Bot state:** offline. Telegram + TUI both expecting offline daemon.
4. **Open PR:** #562 (`fix/doctor-docs-whitelist`) — 1-line, low-risk merge.
5. **Operator's stated intent:** "ostatecznie swiezej instancji memphis do instalacji memphis" — fresh install verification path is P2 #7-9 above.
6. **Don't:** `doctor --fix` (would delete operator's koder brief until PR #562 merged).
7. **Don't:** start daemon without resolving `MEMPHIS_API_TOKEN` (it'll just crash loop again).

---

**Last updated:** 2026-05-11 01:30 CEST.
**Next refresh:** when vault recovery path chosen + executed, OR after fresh-install validation lands.
