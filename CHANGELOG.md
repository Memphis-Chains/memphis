## v1.13.5 - 2026-10-02

40 commits since the `v1.13.4` tag. Two release blockers closed, one test-isolation
defect that wrote to the operator's live configuration, and the Tauri/concurrency
work that was already in flight.

### Release blockers (both found via the nightly-crystal artifact, not the job log)

- **Format gate.** `scripts/format-check-changed.sh` checks `HEAD^..HEAD` only, so
  the gate saw a regression introduced in `ed2f1f4`: 11 files violated Prettier.
  Reformatted; the only text-level change is one `.toBe()` call collapsed to a
  single line, semantics identical, `tsc` clean.
- **Dependency audit.** `@grpc/grpc-js` 1.14.0–1.14.4 carries two High advisories
  (GHSA-m9gg-hp2v-232j, GHSA-f596-whhp-79r4). `nightly-crystal-pass.sh:143` runs
  `npm audit --omit=dev --audit-level=high`, so this is a hard gate, not advisory.
  Bumped to 1.14.5 in `overrides`.

### Configuration isolation (the `sk-test` mystery)

- **`mcp-config-set.test.ts` wrote to the operator's real `.env`.** The test set
  `MEMPHIS_ENV_PATH`; the variable `resolveDotEnvPath()` actually reads
  (`src/infra/config/dotenv-file.ts:7`) is `MEMPHIS_ENV_FILE`. The override was
  ignored, every run resolved the install-root `.env`, and `setDotEnvValues`
  wrote production config — which is how a `ANTHROPIC_API_KEY=sk-test` placeholder
  kept reappearing and why `GEN_TIMEOUT_MS` reverted to a stale 45000 against a
  600000 value the surrounding comment justified at length.
- Fixed the variable name, changed the test value to `123456` (45000 was a real
  operator setting), and added a guard test asserting writes land in the per-test
  tmp `.env`. All 8 original tests preserved.
- **`npm-shrinkwrap.json` is the pin, not `package-lock.json`.** The latter is in
  `.gitignore:9` and unused by `npm ci`. Changing `overrides` without syncing the
  shrinkwrap fails the `Install` step. One-line diff; rebuilding the lock dragged
  in unrelated drift (`@napi-rs/wasm-runtime`, `@tybys/wasm-util`).

### Providers and models

- **MiniMax M3 context window (#654).** The anchored regex in
  `model-capabilities.ts` missed `M3.1-Flash-Preview` and capped it at 32k instead
  of 1M. `MEMPHIS_CHAT_MAX_MESSAGES` raised to 20000 to match.
- **Health now separates "configured" from "usable" (#653).** A provider with a
  vault ref pointing at a non-existent entry is no longer reported as healthy.
- **Dead vault refs removed from `.env`.** `DEEPSEEK_VAULT_KEY` and
  `GLM_VAULT_KEY` pointed at entries that never existed, producing a
  `vault_not_found` loud skip on every boot (`doctor-v2.ts:977`). `MINIMAX_VAULT_KEY`
  is valid and stays.

### Telegram

- **`memphis_send` could not send with real configuration** (`ed2f1f4`). The tool
  read `process.env` directly, so `VAULT:telegram_bot_token` went out verbatim and
  Telegram returned 404, and it looked for `TELEGRAM_CHAT_ID` while the operator
  configures `MEMPHIS_TELEGRAM_CHAT_ID`. Added `resolveTelegramBotToken` with
  vault-first ordering; 10 new test files, one case each (the shared-`stubGlobal`
  approach made the file order-dependent and intermittently unbound).
- **Inbound logging added** to `telegram-presence.ts` — the middleware every
  update already passes through. Logs `updateId`, `fromId`, `username`, `chatId`,
  `allowed`, `tier`, and a 200-char preview, with allowlist-rejected messages on a
  separate `warn`. Previously the gateway logged nothing inbound, so traffic it
  received and dropped was invisible.

### Concurrency, memory, and runtime

- **ADR-009 cross-process write race (#643).** Regression test drives two
  concurrent `writeBlockAtomic` callers; the corruption class is a race, so the
  test has to actually race.
- **Memory persistence limit (#651).** `assistantReply.slice(0, 500)` truncated
  what the embed index saw, so semantic search could not recover long answers
  beyond 500 chars. Raised to 4000 with a `MEMPHIS_MEMORY_REPLY_LIMIT` env
  override and a regression test.
- **Four real bottlenecks behind the three "flaky" timeouts (#650).** Also
  carries the `memphis_soul_write` / `memphis_case_query` / `memphis_case_append`
  JSON Schemas, which were bare `{"type": "object"}` with no `properties` — the
  model was guessing the shape and reaching for `{"item": [...]}`. Now every list
  field is `array` + `items` with `additionalProperties: false`, guarded by
  `tool_schemas_declare_no_array_without_items`.
- **Worker panic surfacing (#652).** A panicking worker reported as
  "stopped without a terminal event"; the panic reason now reaches the operator.
- **Security event no longer corrupts runtime health** (`df290c6`).

### Ops and desktop

- **Backup USB autodetection** (`cd63745`, contract in `315a16d`). The script
  hardcoded a pre-XDG path while this host automounts under `/run/media`, so every
  run exited 2 and `SuccessExitStatus=0 1 2` reported it as success.
- **Tauri Phase G-minimal scaffold** (#644). Two real bugs fixed en route: the
  manifest path was two levels off, and adding Tauri to the cargo `members` list
  broke `cargo build --workspace` on `glib-sys`, so it moved to `exclude` with a
  documented build command.
- **Phase L offline-invariant CI gate**, dashboard DB + API, chain integrity
  sweep with an hourly timer, and `set-github-pat` helper.

### Repository hygiene

- Client data and a Telegram `chat_id` scrubbed from what was, until
  `68780a7`, a public repository. `.gitignore` hardened for operator artifacts
  (`7a99797`, `fe9f150`).
- CHANGELOG entry for v1.13.4, which had 61 undocumented commits (`536812a`).

### Verification

- `unit`: 405 files / 2876 tests passed. `integration`: 60 files / 227 tests passed.
- `tsc --noEmit` and `eslint` clean. `cargo test -p memphis-operator schema`: 6/6.
- `nightly-crystal-pass.sh`: pass=8 fail=0.
- CI run `37038551780` on `23ffbc9`: `quality-gate` 15/15, plus
  `cross-arch (macos-latest)` and `cross-arch (ubuntu-24.04-arm)` both success.
- `.env` md5 identical before and after the full 2876-test suite — the isolation
  fix holds at suite scale, not just on a single run.

### Known limitation

`format:check:changed` only inspects `HEAD^..HEAD`, so 186 files in the repository
do not pass `prettier --check .`. This is the gate's intended scope, not an
oversight, and no repository-wide reformat was done here.

## v1.13.4 - 2026-09-21

### CI portability + scheduled workflow PAT fix

- **CI portability.** Workflow runners and local toolchains diverged on shell/locale assumptions; release and CI paths normalized so `npm run ci` behaves identically on ubuntu-latest and on the operator's WSL2 host. Release commit `e6db168`.
- **weekly-runtime-kpi PAT.** The scheduled workflow could not write to `issues.create` — the repo-level cap on the scheduled token overrides any per-workflow `permissions:` block. Fixed by syncing the CI bot token used by the weekly job (`chore/sync-ci-bot-token-script`, PR #641). GitHub issue #638.
- **README version parity.** README claimed `v1.13.4` while CHANGELOG still stopped at v1.13.2. `daa6aa8` aligned README; this entry closes the CHANGELOG side. Contract covered by `tests/ops/public-status-docs-contract.test.ts` and `tests/ops/release-draft-version-parity-contract.test.ts`.

### Merged after v1.13.3

- **ADR-009 + cross-process write race regression** (PR #643, `4b12631`). Concurrent `writeBlockAtomic` race test, 450 lines, plus the ADR. Regression test is the point: the corruption class is a race, so it needs a test that actually races two writers.
- **Tauri Phase G-minimal desktop scaffold** (PR #644, `b55c94f`). Two real bugs fixed in the process: `src-tauri/Cargo.toml` used `path = "../../crates/..."` but sits two levels below `apps/memphis-gui`, so the manifest never loaded; adding Tauri to the workspace `members` list broke `cargo build --workspace` on `glib-sys`, so it was moved to `exclude` with a documented build command instead.
- **`canSelfModify` computed + MiniMax H3 integration** (PR #649, `738b50c`). Branch reduced from 39 to 7 commits before merge — `git cherry` showed 35 were already in main under different merge commits. Adds the `play-customer-promo-video` skill and `.gitignore` hardening.

### Repository hygiene (2026-09-29)

- **Post-reset memory restoration.** `memphis reset --runtime` cleared chains, soul memory, and several working directories. Restored 14,077 blocks from `pre-reset-2026-09-29` (SHA256-verified, custom linkage check 14,077/14,077 clean), soul selectively (10 preferences, 4 strengths, 9 of 35 learnings after dropping activity-clock noise), plus `halt/`, `audit/`, `scripts/`, `skills/`. Both search indexes rebuilt: FTS 2 → 5,435 entries, semantic 2,084 → 10,046 docs.
- **Embedding throughput characterized, not guessed.** nomic-embed-text costs ~418 ms/chunk on this host regardless of batch size (batch=8 → 381 ms, batch=64 → 410 ms) or concurrency (1/2/4/6 → 418/420/426/424 ms) — Ollama serializes internally. Token-limit edge case found and worked around: dense Polish text at 4,000 bytes exceeds the 2,048-token context window, so chunk 107-c0 needed byte-safe truncation to 3,800.
- **Offsite backup silently broken for 2+ days.** `scripts/backup-to-usb.sh` hardcoded `/media/memphis/usb-backup` (pre-XDG), but this host automounts at `/run/media/$USER/memphis-usb-back`. Every run logged "not a mountpoint", exited 2, and `SuccessExitStatus=0 1 2` reported it as success. Replaced with `resolve_usb_dir()` probe + `MEMPHIS_USB_DIR` override.
- **HALT registry: two dead entries removed.** `477256d46949788d` guarded a linter script that was never committed (verified via `git log --all`), and its premise was disproved — all 10 workflows using `actions/setup-node` already have an explicit `npm ci`. `a3e22cf68b5da623` said "staged but not committed" about a file committed 8 days earlier in `49d301c`, and carried a stale `memphis/` path prefix. Both deregistered with backups and audit entries; `bbb6dcf315560236` kept — `memphis-chain-draft/` is 1,287 LOC outside the repo and the roadmap marks it deferred.
- **Client and account data scrubbed from the public repo.** `notes/szczepan-briefing-2026-04-26.md` (a named third party) removed, copy at `~/private-work/`. Telegram chat id replaced with `${TELEGRAM_CHAT_ID}` across 11 files, and with the neutral `99999999` in 5 test fixtures — 62/62 unit tests still pass. Author name, contact, and host/port deliberately kept: attribution, not leakage.
- **`.gitignore` hardened.** Added `.test-tmp/` (25 stale vitest sandboxes, 804 KB), `work/` (96 MB of private client video renders and conversation dumps), `private-work/`, and `notes/szczepan-*.md`.

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

## Unreleased

## v1.13.0 - 2026-09-05
