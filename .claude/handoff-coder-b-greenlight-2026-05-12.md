# Greenlight do Coder B — /nightly 3 decyzje

**Data:** 2026-05-12
**Decyzja operatora:** wszystkie 3 jak rekomendowane.

## Decyzje

1. **Queue primitive:** SQLite (mirror `evolve_sessions` shape — already proven, audit-friendly, transactional)
2. **6h grant entry:** `/nightly-elevate` slash command (operator-driven; tier-2 + passphrase; auto-revoke after grant window)
3. **Revoke scope:** **all terminal states** (`done`, `cancelled`, `failed`, `timeout`) — uniform revocation rule, no edge cases

## Co Coder B może teraz otworzyć (per własną kolejność)

- **/nightly worker:** spawn → exec Python trainer → status poll → SQLite update → signal handlers (SIGTERM grace shutdown, SIGINT abort + state preserve)
- **/nightly MCP tools:** `memphis_nightly_submit`, `memphis_nightly_status`, `memphis_nightly_cancel`, `memphis_nightly_list`
- **Python trainer signal handlers:** SIGTERM = checkpoint+exit, SIGUSR1 = state dump, SIGINT = abort
- **Job persistence:** SQLite repo `SqliteNightlyJobRepository` + atomic-write helper (already w `feat/kartograf-nightly-training` branch jako `atomic-write.ts` — można reużyć)

## Anti-isolation rule (przypomnienie)

- Kartograf domain = Twoje (Coder B). Memphis-host nie tknie tego sprintu — operator wziął decyzję pod uwagę.
- Memphis side: PR #592 (soul-seed) zmergowane, PR #593 (S5 self-coding) w toku — żaden nie pokrywa /nightly territory.

## Status Memphis-host po tej sesji

| Item | Status |
|---|---|
| PR #592 soul-seed | **MERGED** (operator squash, branch deleted) |
| PR #593 S5 self-coding (6 milestones) | open, CI queued, 5 commits |
| PR #591 S2 SLO + memphis_repair exclusion | open (Q1B + Q2C decided, kod gotowy) |
| PR #590 S1 confab Phase 3 env opt-in | open (decided: default OFF, `MEMPHIS_ANTICONFAB_STRIP=1`) |
| Daemon | active, ~1h uptime, ZERO SEGV-ów po #588 |

## Coder B WIP które są nadal w worktree mojej maszyny (untracked)

Bo mi się przypadkowo wszło, zostawiam na dysku, NIE commitowałem:
- `src/infra/runtime/atomic-write.ts`
- `src/kartograf/rollback.ts`
- `src/modules/nightly/` (cały katalog)
- `tests/unit/atomic-write.test.ts`
- `tests/unit/kartograf-rollback.test.ts`
- `tests/unit/nightly-install-runner.test.ts`
- `tests/unit/nightly-training-job-runner.test.ts`
- `tests/unit/nightly-training-worker.test.ts`
- `tools/training/kartograf_train/status_writer.py`
- `tools/training/tests/`
- `tools/training/kartograf_train/train.py` (modified — was a stash, restored)
- `tools/training/train-kartograf.py` (modified — same)

Wszystko gotowe do `git add` + commit po stronie Coder B.

Jeśli pliki znikną z worktree na ich maszynie, można je odzyskać z git stash:
```
git stash list  # szukaj "Coder B WIP"
```

Tymczasowy backup mojej sesji: `~/Backups/memphis-pre-s5-2026-05-12-2006.tar.zst` (1.1GB) — zawiera ich pliki też.
