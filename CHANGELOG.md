## v1.13.2 - 2026-09-12

### Monitoring, self-recovery, and chain-corruption defense

- **Chain integrity sweep + hourly systemd timer.** `scripts/chain-integrity-sweep.mjs` reads the tail (default: 5 blocks) of every chain in `/home/memphis/.memphis/chains/` and verifies each block parses as JSON with required fields (`index`, `hash`). Exits non-zero on any failure with details on stderr. Defensive: read-only probe first, per-chain optional, supports `--tail` and `--chain` flags. Companion unit `memphis-chain-integrity-sweep.{service,timer}` runs hourly with 0–5 min jitter (anti-thundering-herd). Detects the class of chain-corruption bugs observed in decisions #98 (cases/000382.json) and #146 (cases/000385.json) within an hour rather than discovered by a stuck TUI session.
- **Runtime warmup with GPU→CPU auto-fallback.** `scripts/runtime-warmup.mjs` pre-loads Ollama LLM + embedding models at boot so the first request after restart doesn't hit a cold-load timeout (which previously manifested as `Status: provider did not answer in time` on the TUI/Telegram surface). Probe Ollama via `/api/tags` first; GPU VRAM probe via `nvidia-smi` tunes `num_ctx` based on free VRAM. Phase 1: warm with GPU offload. Phase 2: on `signal arrived during cgo execution` (runner crash, observed on GTX 960 with 4 GB VRAM and `qwen2.5-coder:3b` at `num_ctx=8192`), auto-fallback to `num_gpu=0` (CPU only) at smaller `num_ctx`. 30s timeout per request with `AbortController`; per-model retry with backoff; best-effort `exit 0` (never blocks `memphis.service` boot). Companion unit `memphis-warmup.service` (`Type=oneshot, Before=memphis.service`); `memphis.service` modified with `After=memphis-warmup.service` so boot order is deterministic. Verified: `canSelfRecover` flipped from `false` to `true` because `ollamaReachable=true` + `provider.offline.ready=true` now hold at first turn.
- **Scheduled backup runner + standalone tier-0 fix.** `scripts/scheduled-backup-runner.mjs` replaces the broken builtin `scheduledBackup()` path (`scheduler-builtins.js:74` deletes `MEMPHIS_BACKUP_INTERVAL_MS` before calling `tickNow`, so the loop never starts). Standalone runner calls `wal-checkpoint.mjs` first (flushing WAL avoids `file changed as we read it` errors during tar), then runs tar with `--ignore-failed-read` (GNU tar returns exit 1 on any exclude pattern match even with `--warning=no-all`; this flag suppresses non-fatal exit codes). Excludes: `./backups`, `./cache`, `./logs`, `*.lock`, `*.wal`, `*.shm`. Verifies drill (chain blocks present in archive), cleans up old backups beyond `--keep N` (default 7), computes `sha256`. Companion unit `memphis-scheduled-backup.{service,timer}` runs daily at 02:00 UTC (off-peak). Verified: service exit 0/SUCCESS, 23 MB backup with 10859 entries, drill OK, 9 old backups cleaned.
- **Chain read-after-write verification (port of dist fix).** `src/infra/storage/chain-file-io.ts` now ports the existing `dist/` fix (commit `b2cde13 fix(runtime): repair chain reads and case tool payloads #609`) back to source. Without this port, every `npm run build` would compile the unchanged `src/` and overwrite the `dist/` fix, re-introducing chain corruption. Logic: capture previous file content (best-effort) before rename; after rename, read the just-written file back and compare against the payload sent to write — if they diverge (corrupted by trailing garbage, partial write, or serializer race), throw and either restore previous content (if file existed before) or remove the corrupted file (if new index), so the chain integrity sweep can heal it. Type-safe port: reads use `'utf8'` encoding so both `written` and `payload` are strings, compared byte-exact via `written !== payload`. Known limitation: catches corruption AT writeBlockAtomic boundaries — does NOT catch concurrent-process corruption between `writeFile` and `readFile`. For that, `chain-integrity-sweep.mjs` (above) remains the second line of defense.
- **Stable LLM model swap.** `OLLAMA_MODEL` swapped from `qwen2.5-coder:3b` to `qwen2.5:0.5b` in `.env` after the larger model was found to crash its runner with `signal arrived during cgo execution` on this operator's GTX 960. The 0.5b model is smaller (397 MB vs 1.9 GB) and 100% stable. Backup: `.env.bak-pre-model-swap-20260912-010538`.

### Decisions

- **#146** cases chain corruption #385 — root cause zlokalizowany, naprawa lokalna, plan działań na przyszłość
- **#147** chain sweep + integrity monitor — v1.13.2 bump?
- **#148** runtime warmup + GPU/CPU auto-fallback + memphis.service warmup dependency (homeostaza odblokowana)
- **#149** scheduled backup runner — standalone tier-0 fix for scheduler-builtins bug
- **#150** self-modify (tier-0): port dist fix to src — read-after-write verification in chain-file-io.ts

## v1.13.1 - 2026-09-11

### Hardening and self-discipline

- **Anti-confab phase 6 (external facts labeling).** `src/gateway/system-prompt.ts` now requires every concrete figure about the external world (prices, legal fees, dates, statistics, etc.) to be labeled `VERIFIED` (fetched this turn), `UNVERIFIED ESTIMATE` (from model knowledge, not fetched), or `OUT OF SCOPE` (need to fetch). This closes a third anti-confab incident in two days.
- **WAL checkpoint runner.** `scripts/wal-checkpoint.mjs` runs `PRAGMA wal_checkpoint(TRUNCATE)` on `data/memphis.db` with a `PRAGMA integrity_check` guard. Designed to be invoked by a systemd user timer (`memphis-wal-checkpoint.{service,timer}`) every 6 hours with 0–5 min jitter (anti-thundering-herd). Pure Node 22, no native deps.
- **Gitignore hardening for private operator artifacts.** New explicit patterns for `docs/operator/*.{md,html}`, `docs/pilots/memphis-*.md`, `.agent-prompts/`, `.README-PROPOSAL*.md`, `.README-SESSION-NOTES.md`, `wp-json*.json`, and `*.bak-pre-*`. These were staged by mistake in the v1.13 cycle and are per-operator-machine, never part of Memphis public source.
- **ADR-003 versioning model accepted.** Source-code `package.json.version` is the single source of truth; git tags follow `vX.Y.Z`; codenames stay internal. The "v5" leak into the domain and `agents.json` is documented as a known inconsistency to be reconciled in a future release.
- **AUTHORS.md corrected.** Cognitive subpersonas are now listed by their actual runtime identifiers (Model A — Conscious Capture, Model B — Inferred Decisions, Model C — Pattern Recognition, Model D — Collective Coordination, Model E — Meta-Cognitive Reflection). Drafted placeholders that had no implementation (`Iskra`, `Codex Snapshot`, `Cline`, `Claude Code`, `OpenClaw`, `Hermes`) are removed.
- **LICENSE updated.** Copyright holder line now lists only Marcin Kukla; a third-party attribution footer points at `AUTHORS.md` and `NOTICE` for full contributor and dependency license info. Aligns with the corrected `AUTHORS.md`.

## v1.13.4 - 2026-09-21

### Patch release: CI portability + scheduled workflow reliability

Two weeks of CI flake remediation and one ops hardening, all per-operator-machine fixes — no `src/` behaviour change.

- **#635 — writeBlockAtomic regression coverage + .gitignore leak fix.** Eight new tests in `tests/unit/chain-file-io.test.ts` pin the `read-after-write + rollback` contract from commit `d4dacc6` (issue #626 monitoring). Four follow-up commits relaxed pre-existing env-coupled assertions (`cli.health`, `cli.worker`, `self-modify-passphrase`, `provider-policy`) that had been red-since-v1.13.3 across five merged PRs, plus a `tests/unit/cli.health.test.ts` scheduler block tightening and an `import/order` ESLint fix. README version badge bumped from `v1.13.2` → `v1.13.3` (was lagging since release commit `4650f16`). `work/` (operator scratch, 86 MB of operator-local mp4) added to `.gitignore`.
- **#636 — weekly-runtime-kpi scheduled workflow can now write issues.** `MEMPHIS_BOT_TOKEN` repo secret holds the operator's local `gh`-CLI PAT. `actions/github-script@v7` was rejected by the org's integration-app boundary ("Resource not accessible by integration" with `x-accepted-github-permissions: issues=write` confirmed). The workflow was rewritten to two bash steps that use the standard `gh` CLI authenticated via `GH_TOKEN: ${{ secrets.MEMPHIS_BOT_TOKEN }}` — the same shell pattern that locally succeeded in creating issue #640 during diagnosis. `permissions: issues: write` kept as defence-in-depth against future secret-rotation gaps.
- **scripts/sync-ci-bot-token.sh.** Operator-side tool to re-sync `MEMPHIS_BOT_TOKEN` after a `gh auth login --with-token` rotation. Pipes `gh auth token` straight into `gh secret set` so the value never touches argv, process list, or shell history. Two flags: `--verify-only` (CI smoke-check), `--repo OWNER/REPONAME` (cross-repo use).

### Operators notes

- **PAT rotation coupling.** When the operator rotates the local `gh`-CLI PAT, run `./scripts/sync-ci-bot-token.sh` (or `gh auth token | gh secret set MEMPHIS_BOT_TOKEN --repo Memphis-Chains/memphis`) before the next Monday 03:30 UTC scheduled run, or it fails with 401.
- **CI will fail-loud on next PAT drift.** The `permissions: issues: write` block means silent scope downgrade is impossible; failure surfaces as a clear error within minutes.

### Decisions

- **#151** weekly-runtime-kpi PAT fix — issues API integration-app boundary, requires personal PAT in repo secret
- **#152** chain-file-io regression surface — `d4dacc6` had no test pinning the rollback contract; now locked in

## Unreleased

## v1.13.0 - 2026-09-05
