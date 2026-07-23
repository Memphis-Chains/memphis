## Unreleased

## v1.11.0 - 2026-07-22

This release closes the 50-commit stabilization and modernization window after
`v1.10.0`. It advances the operator-supervised runtime without changing the
project's local-first trust boundary, and restores the public documentation and
release metadata to the executable state of `main`.

### Runtime and operator experience

- Completed the runtime modernization closeout and restored readiness
  invariants across the native operator, CLI, HTTP, MCP, and Telegram surfaces.
- Added plan-aware self-coding, operator-mode execution guidance, and stronger
  provider identity/context reporting based on the route actually used.
- Added chunked, multi-vector embeddings for content above 4 KB and repaired
  chain reads, case tool payloads, Rust-compatible block hash validation, and
  shutdown handling for the embedding and Kartograf runtimes.
- Persisted Telegram photo/document attachments, tightened the gateway execution
  policy path, and installed reboot-safe local runtime services.

### Security and reliability

- Made vault initialization fail closed when encrypted entries already exist,
  unless the operator explicitly requests a forced reinitialization.
- Isolated test audit writes from live chains, hardened known-fork startup
  handling, and added machine-local/secret artifact protections to `.gitignore`.
- Updated vulnerable Rust and npm dependencies, including `tar` `7.5.20`,
  `sharp` `0.35.3`, `fast-uri` `3.1.4`, and the OpenTelemetry Jaeger propagator
  `2.10.0`; the production audit gate reports no high or critical advisories.
- Repaired source-build N-API resolution, release smoke ordering, fresh-install
  verification, and nightly CI range selection.

### Public and release contract

- Replaced stale README snapshots with the current 11-chain, provider-routing,
  authorization, bootstrap, and CLI contracts.
- Added a maintained Polish operator README and verified the public website,
  installation, and documentation entry points.
- Synchronized release version updates across `package.json`,
  `npm-shrinkwrap.json`, and both public READMEs so future RC and GA automation
  cannot publish contradictory version metadata.

## v1.10.0 - 2026-05-12

Closes the 10-day window since `v1.9.2` (2026-05-08 → 2026-05-12) — 91
commits across 15 feats, 42 fixes, 10 docs, plus a full Kartograf v4
training arc. The `package.json` version field jumps from `1.8.0` to
`1.10.0` to re-sync with the `v1.9.x` tag line; the intermediate
`v1.9.0/.1/.2` shipped without `package.json` bumps or CHANGELOG
entries (post-Zawoja autopilot pace — operator deliberately held
`v1.10` for stability per `project_closure_2026-05-09.md`).

This is the **bigger-than-usual** release: Kartograf inference goes
from "stub returning zeros" to a real ONNX runtime backed by an
operator-trained checkpoint, three new ingestion surfaces land on
Telegram (voice, photo, document/PDF), and the MiniMax provider
finally knows about its actual model lineup.

### Highlights

- **Kartograf ONNX runtime** — the Q2-spec `Runtime (onnxruntime-node)`
  closure. `memphis_kartograf` tool gates on `MEMPHIS_KARTOGRAF_ENABLE=1`
  - an installed checkpoint, lazy-loads the ~700-MB ONNX graph as a
    process singleton, returns a 256-d embedding + 12-class zone
    distribution per call. Replaces `StubKartografSession` which was
    silently emitting zero vectors. (#573)
- **Kartograf v4 training stack** — DeBERTa-v3-base + LoRA fine-tune
  pipeline (`tools/training/train-kartograf.py`) producing signed
  Ed25519 checkpoint envelopes. Operator-grade GPU (GTX 960 / Maxwell
  sm52) end-to-end run completed 2026-05-12 (10h12min, 1846 steps,
  recall@10 = 0.27, macro_f1 = 0.63). (#564)
- **`kartograf-zone-router` built-in skill** — composes routing
  decisions over `memphis_kartograf` + `memphis_recall` +
  `memphis_journal` before writing to a chain. Cites the model's
  `checkpointId` in the audit trail so writes can be traced to the
  model version that picked them. (#573)
- **First-class skill composition** — five `memphis_skill_{list,show,
create,validate,install}` tools so Memphis can scaffold + validate
  - install skills without round-tripping via `memphis_fs_write` +
    `memphis_exec memphis skills create`. The validator catches schema
    mistakes BEFORE install with a `suggestedFix` hint ("did you mean
    memphis_self_describe?"). Anti-confab rule E rejects fake tool
    names in code fences via Levenshtein nearest-match. (#572)
- **Telegram document / PDF ingestion** — `bot.on('message:document')`
  handler. PDFs go through `pdftotext -layout` (poppler), text files
  read raw UTF-8, images-as-documents reuse the vision+OCR pipeline,
  every other type gets honest "unsupported, ask the user" framing.
  Caps: 10 MB per attachment, 12 KB PDF body / 256 KB text body in
  the prompt. (#574)
- **Full MiniMax model lineup** — provider config refreshed against
  `platform.minimax.io/docs/guides/models-intro` (2026-05-12 snapshot).
  All 12 current chat models exposed in `listModels()`: M2.7 +
  highspeed, M2.5 + highspeed, M2 (200k/128k), M2.1 + highspeed,
  m2-her (roleplay), plus legacy M1 / Text-01 / abab-\*. Per-model
  context windows in `minimaxCapabilities()` (M2 family = 200k; was
  hardcoded 32k for every model). Endpoint routing fixed to handle
  `m2-her` (which doesn't have the `MiniMax-` prefix). (#575)
- **Telegram TTS shaping** — voice replies cap at 6 sentences with
  "Reszta w tekście" overflow notice; markdown/URLs/emoji/ZWJ stripped
  before synthesis; default voice flipped from `gosia` to `darkman`
  (operator preference). Piper HTTP server defaults to the new voice.
  (#571)
- **Voice pipeline reboot survival** — `whisper-server.service` and
  `piper-server.service` user units installed by
  `scripts/voice-install.sh`. STT/TTS comes back automatically after
  daemon reboots; no manual `python -m whisper_cpp_server` dance.
- **Provider stamp flipped to opt-in** — the in-body
  `— via {provider}/{model}` footer is OFF by default. Operator
  confirmed 2026-05-12 it was noise on Telegram and frequently
  misleading when provider cascade switched mid-call. Power users
  can re-enable via `MEMPHIS_PROVIDER_STAMP=1`. Legacy `=0` still
  honored. (#573)

### Security & Vault

- **Degraded boot on missing vault secrets** — operator's
  `MEMPHIS_API_TOKEN=VAULT:...` reference with a missing vault entry
  no longer crashes the daemon. The boot path distinguishes
  "secret unconfigured intentionally" from "secret missing", emits a
  recovery hint, and brings the daemon up in degraded mode so the
  operator can diagnose interactively. (#568, addresses P1 #5 from
  `docs/roadmap/2026-05-11-post-autonomy-todo-and-gap.md`)
- **Vault-recovery runbook** — `docs/operator/VAULT-RECOVERY-RUNBOOK.md`
  documents the path operators take when `pepper-rotate` leaves
  vault inconsistent (the 2026-05-11 incident). Three recovery
  options (plain-text bypass, master-key restore, full re-init) with
  decision criteria. (#567, addresses P1 #6)
- **Tier-3 session persistence across daemon restart** — tier-3
  sessions now persist via `data/tier3-sessions.json` (encrypted
  under the vault master key) so a daemon restart doesn't drop the
  operator's elevation. Auto-expires sessions whose TTL has passed
  during the offline window. (#566)
- **OTEL audit allowlist** — `GHSA-q7rr-3cgh-j5r3` (prometheus
  exporter transitive advisory) added to CI's `npm audit` filter so
  the unrelated advisory doesn't block PRs. The advisory itself is
  tracked as out-of-scope (we don't use the prometheus exporter
  path). (#569)

### Provider / orchestration

- **Provider auto-failover on stream timeout** — orchestration service
  detects per-provider stream timeouts and rotates to the next
  configured provider in the cascade instead of returning a partial
  reply. Cooldown-blocked providers are skipped; auth + validation
  errors are NOT retried (operator must fix the credentials).
  Audit-event-stamped each rotation. (#570)
- **Fallback provider real LLM** — `fallbackProvider` switched from
  `local-fallback` stub to real `ollama`. Cross-provider cascade now
  ends in a working model when MiniMax / Anthropic both refuse,
  instead of a placeholder stub message.
- **Anthropic whitespace text-block filter** — strips whitespace-only
  text content blocks before sending; pre-fix, the Anthropic API
  rejected such blocks with 400 errors that surfaced as cryptic TUI
  errors.
- **Anthropic Opus 4.6 default + fallback chain** — default Anthropic
  model promoted to `claude-opus-4-6` with `claude-opus-4-7` as
  fallback. Window-cache 128k enabled so long-context conversations
  don't pay full-prompt token cost per turn.
- **Per-provider timeout knobs** — every per-provider timeout reads
  from `src/config/env-registry.ts` instead of hardcoded constants.
  Operator can tune `MEMPHIS_ANTHROPIC_TIMEOUT_MS`,
  `MEMPHIS_MINIMAX_TIMEOUT_MS`, etc. without touching code. (#520)

### Memory + cognition

- **Anti-confab Phase 2 (warn-append) → Phase 3 (strip-sentence)** —
  Phase 2 default-shipped in `v1.9.x`; Phase 3 implemented as opt-in
  via `MEMPHIS_ANTICONFAB_PHASE=3` (regex-strips offending sentences
  from the reply instead of just appending a warning). New rule E
  catches fake-tool-name claims in code fences with Levenshtein
  nearest-match → "did you mean memphis_self_describe?". Default
  stays Phase 2; operator can flip to 3 after 1-2 weeks of data.
- **Schema-error sample in `memphis_soul_write` rejection** — the
  validator now emits a "Correct shape: ..." example beside the
  error so the model can self-correct in one retry instead of
  flipping array vs string on consecutive attempts.
- **Embed bulk upsert + NDJSON v2 + explicit flush** — embed-reindex
  pipeline rewrites the disk index with bulk SQL upserts + an
  explicit periodic flush. Eliminates the I/O amplification storm
  the repair-runtime path was triggering on full rebuilds.
  `MEMPHIS_EMBED_DISK_V2=1` opt-in default-flip pending P5 #17.

### Operator surface

- **`memphis_kartograf` first-class tool** — daemon agent loops can
  call Kartograf inference directly during chain-routing decisions.
  Tier-1 read-only; structured `stateKind` (`disabled` /
  `no-checkpoint` / `load-failed` / `ready`) instead of silent
  zero-vector degradation. (#573)
- **Doctor `~/.memphis/docs/` whitelisted** — operator's brief
  output no longer flags the docs subdirectory as "unknown dir".
  (#562, P3 #14)
- **Install prerequisites auto-installs `python3-venv` +
  `tesseract-ocr`** — fresh installs no longer hit "python3 -m venv:
  command not found" mid-onboarding.
- **TUI CPU halved** — poll interval doubled (50 → 100 ms active,
  250 → 500 ms idle). Operator's TUI session goes from 110% CPU to
  ~55%.
- **MiniMax (None / None) overflow render gone** — the operator-side
  ContextOverflow render no longer emits ugly `(None / None tokens)`
  placeholders when upstream metadata is unavailable.
- **`memphis vault pepper-rotate` cwd anchoring** — pepper-rotate
  writes to `~/memphis/.env` regardless of cwd. Previously could
  write to `$HOME/.env` if the operator ran it from outside the
  repo root (cause of 2026-05-11 vault desync incident).

### Docs

- **`docs/operator/DAILY-ASSISTANT-SETUP.md`** — one-stop
  "dżin w komputerze" guide covering install → init → Telegram →
  voice → first conversation.
- **`docs/dev/agent-operational-patterns-2026-05-10.md`** — 10
  heuristics for log analysis + daemon-watch agent ops.
- **`docs/dev/full-memphis-recon-2026-05-11.md`** — three architecture
  maps (process tree, chain topology, vault encryption boundary).
- **`docs/operator/kartograf.md`** — Y2-deferred → "ships today"
  section, activation steps, and `kartograf-zone-router` skill
  description.
- **`docs/dev/vault-pepper-atomic-rotate-plan-2026-05-12.md`** — full
  plan for the deferred atomic re-encrypt work (12-16 h focused
  engineering across 4 phases). Plan + risks; implementation
  intentionally not shipped this release (size + crypto-correctness
  risk).
- **`docs/roadmap/2026-05-11-post-autonomy-todo-and-gap.md`** — P0-P5
  punch list from the post-autonomy session, with status callouts
  resolved in this release.
- **`docs/roadmap/post-v1.9-broad-roadmap.md`** — six-item operator-
  dictated direction (OAuth Anthropic, STT/TTS local, video
  pipeline, offline, Matrix Agora, `/marketplace`).
- **`docs/dev/v1.10.0-deferred-work.md`** — explicit map of
  TODO-not-shipped items per category with rationale.

### Deferred from this release (carry-over)

Per `docs/dev/v1.10.0-deferred-work.md`:

- **Vault pepper atomic re-encrypt** (P1 #4) — plan written
  (`docs/dev/vault-pepper-atomic-rotate-plan-2026-05-12.md`); 12-16 h
  of focused crypto work across 4 phases. Holding for a dedicated
  sprint with operator review between Phase 2 and Phase 3.
- **Fresh-install validation surface** (P2 #7-9) — automated
  `fresh-install-smoke.test.ts` + operator-runnable script + manual
  verification doc. Will close the loop on "does a clean install
  actually work end-to-end".
- **Cache-stability test for Anthropic prompt caching** (P5 #18) —
  byte-equality assertion on rebuilt system prompts across calls.
- **Daemon native-fault diagnosis** — operator installed
  `systemd-coredump` on 2026-05-12 so the next runtime SIGSEGV will
  be preserved. Pattern observed: ~17-41 min uptime → silent native
  crash → systemd auto-restart. `Node --report-on-fatalerror`
  doesn't catch it (fault is below the V8 signal handler). After
  the next preserved coredump → `gdb` stack identifies the native
  library responsible.

### CI / infrastructure

- **OTEL transitive-advisory allowlist** — `GHSA-q7rr-3cgh-j5r3`
  filtered via `jq` in the `npm audit` step so `quality-gate`
  doesn't red-flag every PR over a transitive advisory in an
  unused export path. (#569)
- **Scheduler git-pull `--ff-only`** — the auto-update path refuses
  to do non-fast-forward rebases. Eliminates the race where two
  concurrent daemon-side `git pull`s could leave the work tree in a
  merge-conflict state.

## v1.8.0 - 2026-05-02

Closes an 84-commit window since `v1.7.2` (2026-04-25 → 2026-05-02).
Three primary themes: **security & authorization** hardening, **operator-trust**
polish, and **per-platform npm distribution** readiness.

### Platform support

**Linux is the canonical v1.8.0 target.** Per-platform NAPI sub-packages
are configured for `linux-x64-gnu`, `linux-arm64-gnu`, `darwin-x64`, and
`darwin-arm64` (`prebuilds.yml` builds + publishes all four on tag),
but macOS is **build-from-source** for v1.8.0: one cli-router test
fails on `macos-latest` due to a `vi.doMock` timing issue (#407) that
needs a Mac to debug. Prebuilt darwin sub-packages still ship; the
`continue-on-error: true` flag on the cross-arch CI matrix stays
until #407 closes (planned for v1.8.1). macOS operators with the Rust
toolchain can still use Memphis end-to-end via `npm run build:rust`.

### Highlights

- Every state-mutating CLI command now requires operator authentication
  (`memphis auth audit` surfaces the gate matrix; `gapCount=0` on main).
- `npm install` finally ships the Rust NAPI bridge — Linux x64 fresh
  installs work without a manual `npm run build:rust`. Darwin/arm64
  via build-from-source for v1.8.0 (per-platform prebuilds publish
  via `prebuilds.yml` on tag, so v1.8.1 picks them up automatically).
- First-run gate on `memphis chat` / `ask` / `tui` returns a `NOT_INITIALIZED`
  error pointing at `memphis init`, instead of silently falling back to a
  stub provider.
- `memphis doctor --fix --apply` lets operators clean orphan files safely,
  with a timestamped backup under `~/.memphis/backup-<ts>/`.
- Provider factory honesty: `resolveProvider` was a long-standing stub
  returning `null`, making `enableLLMFallback` silent dead code; wired to
  the real Ollama provider with availability cache + 3 s probe timeout.
- Matrix federation deleted (`-3085 LOC`) and the env / path-resolver
  layers consolidated to single sources of truth.
- Release artifacts ship `SHA256SUMS` for integrity verification. GPG
  signing scaffold present in `release.yml` — activates automatically
  once `GPG_PRIVATE_KEY` repo secret is configured (deferred to v1.8.1).

### Security & Authorization

- `requireOperatorAuth` sweep closes 5 gap commands: `secret add/get/list`,
  `trust add/remove + mode set`, `backup restore + clean`, `evolve rollback`,
  `reset --runtime`. Audit matrix `gapCount` goes from 5 to 0. (#389,
  closes #278/#279)
- New `memphis auth audit` subcommand exposes a `registered/enforced/gap`
  matrix; detector grep-scans handler/command files (TS source + dist JS),
  excluding comments. Multi-command dispatch via word-boundary regex. (#388)
- Per-request `MEMPHIS_AUTONOMY_MODE` overrides now reach the soul manifest
  via `tool-executor` and `mcp/tools/self-modify` — closes the architectural
  smell where tier-3 elevation could not unblock tier-2 tools on per-request
  paths. (#387)
- Provider factory honesty: `resolveProvider` no longer silently returns
  `null`; wired to the real `OllamaProvider` with model presence check,
  exact-tag matching, 30 s availability cache, and 3 s `listModels`
  timeout. (#386)
- `memphis_exec` system-prompt un-castration: prompt no longer tells the LLM
  exec is "diagnostic only" regardless of mode — surfaces the actual tier
  policy. (#341)
- Anti-confabulation guard in agent runtime; `memphis_self_describe` is
  surfaced as a forced introspection step. Confabulation event detector +
  7-day health counter in observability. (#327, #324)
- Vault state files enforce `0600` perms at write time and heal-on-load
  for existing installs that drifted. (#272 → #375, #329)
- Secret-scan recognizes OpenAI (admin/proj/test/live/None), Stripe, and
  Mistral key prefixes; mirrored into the kartograf training corpus. Symlink
  traversal via `find -L`. (#274 → #376)
- Vault refs distinguish resolved vs failed states. (#276 → #377)
- Symmetric on/off via `try/finally` in `monitorRuntime` tick listener
  cleanup. (#277 → #378)
- New RFC: Shamir secret sharing for vault recovery. (#345)

### Distribution & Install

- npm tarball now ships `crates/memphis-napi/index.node` via a `prepack`
  release-mode rebuild. Probe-load + glibc/musl detection in postinstall.
  Fresh `npm install -g` on Linux x64 works without `npm run build:rust`.
  (#390, S9-0)

### Operator UX & Doctor

- First-run gate on `memphis chat` / `ask` / `ask-session` / `tui`: rejects
  with a `NOT_INITIALIZED` error naming `memphis init` as the next step,
  instead of silently routing to a local-stub provider. `tui host` (stdio
  JSON-RPC mode) bypasses the gate. (#393, S10-5)
- `memphis doctor --fix --apply` for orphan cleanup with timestamped backup
  to `~/.memphis/backup-<ts>/`. Whitelisted canonical entries include
  agent-generated dirs (`discoveries/`, `kartograf/`, `scripts/`). Default
  is dry-run; mutation requires explicit `--apply`. (#383, S4-1)
- `memphis doctor --post-install` for fast tier-1 sanity (data dir +
  chains + vault + .env + systemd visibility) without provider health,
  performance, security checks. (#363)
- Doctor surfaces the embed backend label (CPU/GPU/Metal) in the latency
  check so operators can diagnose Ollama-CPU regressions instead of
  guessing. (#380, S4-2)
- Cron task failures get a log path (`~/.memphis/logs/cron/<task>/<run>.log`)
  and a doctor-cron section that surfaces failure history. (#382, S4-4)
- Cron `bash -lc` shells re-assert `cwd` after profile load and clear `$@` /
  set `$0=bash` to fix the `morning-raport-wodzu` PATH miss. (#384)
- Doctor chain-repair iterator skips `<chain>.backup-<ts>` snapshot dirs
  instead of complaining about "invalid chain name". (#385)
- README cheatsheet accuracy pass: removed nonexistent `memphis journal` /
  `recall`, fixed `secret set` → `secret add --key/--value`, pointed
  `key-lifecycle` link to canonical `docs/dev/`. (#394, S10-6)
- Doc-link sweep: 22 stale `docs/X.md` references remapped to canonical
  `docs/operator/` / `docs/dev/` / `docs/historical/`, plus a regex
  contract test catching uppercase + lowercase + fragment + `./`-prefix
  variants. (#391, S10-1)
- New English `docs/operator/install-fresh-user.en.md` (12 steps with
  verification, mirrors `.pl.md`). (#392, S10-2)

### Bug Fixes

- GLM provider: keep `AbortController` across body parsing, drain error
  bodies, classify-status-first, clamp `setTimeout` to `TIMEOUT_MAX`,
  cascade-aware error mapping for cleaner failover. (#381, S4-3)
- Soul manifest path lookup correction. (#361)
- Rust vault path defaults aligned with TS layer; `vault sync-env`
  detects path split and emits a meaningful local-fallback notice once
  per process. (#362, #350, #351, #355)
- TUI runs refreshed on a background thread; main loop never blocks
  on it (15 s lag fix). (#371)
- Apps manifest defaults to `linux+darwin+win32` platforms when
  unspecified. (#373)
- macOS-portable tmpdir helper via `realpathSync(tmpdir())` — closes
  8 path-symlink test failures. (#372)
- Production-safety check accepts `vault-key` references in place of
  plaintext for sensitive env vars. (#369)
- `self-update` falls back to `origin/main` when the current branch has
  no upstream. (#368)
- MiniMax: coalesce all system-role messages into a single leading one
  (400 fix); parse inline `<toolcall>…</minimax:tool_call>` XML in
  content. (#366, #367)
- CLI: eagerly resolve `VAULT:<key>` refs in `process.env` on every
  command. (#365)
- Ollama: default `keep_alive` to `"24h"` so the model stays warm
  out-of-box; expose `OLLAMA_KEEP_ALIVE` for operator override. (#348,
  #354)
- CLI: `vault add/get/entry-delete` accept positional key argument
  (`vault add <key> --value …`). (#321)
- CLI: `--cron` and `--type` aliases for `--cron-pattern` /
  `--task-type`. (#352)
- CLI handler `'full'` mode option exposed in the autonomy switcher.
  (#342)
- Soul manifest reads now apply `MEMPHIS_AUTONOMY_MODE` env override
  on every read (sprint 1.1 B1 sweep). (#325, #326)
- Pino flush ordered before NAPI `embed_shutdown` — closes one of the
  SEGV-on-shutdown causes. (#333)
- Vault `fsync` failures + security audit + Rust-loop fallback now
  surface to stderr instead of silent-swallow. (#328)

### Documentation

- New `docs/operator/FORCE-FLAGS.md` documenting `MEMPHIS_VAULT_FORCE_REINIT`
  and `MEMPHIS_RESTART_ALLOW_SUICIDE` bypass contracts; runtime error
  messages cross-link to the doc. (S7-1)
- `docs/dev/codebase-truth-snapshot.md` 2026-04-27 baseline. (#322)
- `docs/operator/SHUTDOWN-LIFECYCLE.md` covering the SEGV repro and
  shutdown ordering. (#343, Track B)
- `docs/ops/quarterly-disaster-restore-drill.md` runbook. (#344)
- README version bump v1.4.0 → v1.7.2 + feature highlights refresh.
  (#379, S1-5)

### Refactoring

- Matrix federation deleted (`-3085 LOC`). Sprint 1 A1+A2. (#356, #357)
- Boolean parsers consolidated into `src/core/env.parseBool` (single
  source of truth, accepts `1/yes/on` truthy + `0/no/off` falsy).
  (#358, #320)
- Path resolvers inlined; `getDataDir` / `getVaultPath` / `getChainPath`
  in `src/config/paths.ts` are canonical. (#359)
- Chain-integrity test files merged. (#360)
- `MEMPHIS_DIR` alias dropped — single canonical `MEMPHIS_DATA_DIR`.
  (#374)
- 2 orphan modules removed (Sprint W4 wiring audit). (#336)

### Tests & CI

- Cross-arch CI matrix (ubuntu-arm + macos-latest) plus chain-format
  compat test in Track C4. (#347)
- SEGV stress test for `mcp serve` + full daemon. (#340, Track B)
- Preflight gate stdout capture + vitest singleFork. (#339)
- E2E vault-entries path isolation. (#337)
- 5 runtime env vars documented in `envSchema`. (#335)
- 3 MCP tools registered: `memphis_self_describe`, `memphis_repair`,
  `memphis_cron`. (#334)

### Internal

- MCP cast helper consolidated; scheduler `HOME` resolution; backup
  progress reporting (sprint 3.2). (#330)
- Codex P1+P2 fixes consolidated for Track C #343-#346. (#349)
- OTel `withSpan` adopted at turn/provider/tool boundaries. (#323)
- Photo handler with honest fallback in channels. (#332)
- Kartograf TS session-layer scaffold (sprint 4.2, N32 prep). (#331)

## v1.7.2 - 2026-04-27

Hotfix release. v1.7.1's one-liner installer would clone, build, and link
the CLI — but `memphis init` then failed with "requires a configured .env
file; run npm run bootstrap first" because install.sh skipped bootstrap.
The README's manual flow hit the same wall. Effectively NO documented
fresh-install path produced a working install. v1.7.2 closes that gap.

### Fixed

- **install.sh runs `npm run bootstrap` unconditionally** (#316) — between `npm link` and the optional `memphis init`. Bootstrap creates `.env` from `.env.example`, generates random API token + vault pepper, ensures the agent profile, optionally installs the user systemd unit. Without this every install ended in "linked CLI that can't run init".
- **`memphis init` auto-creates `.env` from `.env.example` as a safety net** (#316) — operators who skip install.sh's bootstrap step (manual clone + build, or install.sh without `--with-init`) now get a working init with a warning recommending `npm run bootstrap` for token generation, instead of a hard error.
- **`bootstrap.sh vault_initialized()` checks the right path** (#316) — was checking `${HOME}/.memphis/vault/vault-entries.json` (with `/vault/` subdir) but the actual runtime default is `${HOME}/.memphis/vault-entries.json`. Stale guess fixed.

### Verified

End-to-end on a fresh clone: clone → `npm install` → `npm run build` → `memphis init --non-interactive` produces vault initialized, operator configured, 2 chain blocks created. The `curl ... install.sh | bash -s -- --with-init` one-liner now produces a complete working install on a fresh PC, end of session.

## v1.7.1 - 2026-04-27

Fresh-install hotfix release. v1.7.0's vault-bridge fix (#306) only addressed one of six places
the cwd-vs-installRoot bug hid in. Operators on legacy `.env` files (shipped from `.env.example`
with relative path overrides) hit "Rust vault bridge not available at ./crates/memphis-napi"
even after pulling v1.7.0. This release closes the gap end-to-end so the curl-installer
one-liner produces a working install on a fresh PC.

### Fixed

- **Install-root anchoring sweep across 6 sibling files** (#314) — chain-adapter, rust-chain-adapter, rust-embed-adapter, graceful-shutdown, doctor's bridge probe, and rust-vault-adapter all now share `resolveRustBridgePath()`. Previously each had its own `?? './crates/memphis-napi'` fallback so vault, chain, embed, doctor, and graceful-shutdown all silently broke when `memphis` ran from any directory other than the source checkout. Sister fix in startup-guards.ts: trust-root path defaults to `<installRoot>/config/trust_root.json` instead of `./config/trust_root.json` (security-critical asset must not depend on cwd).
- **Relative env overrides resolve against installRoot, not cwd** (#314) — `RUST_CHAIN_BRIDGE_PATH=./crates/memphis-napi` and `MEMPHIS_VAULT_ENTRIES_PATH=./data/...` style overrides shipped in legacy `.env` files now resolve against installRoot when relative. Absolute overrides remain verbatim. Without this, post-#306 operators with old `.env` files re-hit the same bridge-not-found break that v1.7.0 was supposed to close.
- **Drop stale relative-path defaults from .env.example + onboarding wizard** (#315) — `RUST_CHAIN_BRIDGE_PATH`, `MEMPHIS_VAULT_ENTRIES_PATH`, `RUST_EMBED_PERSIST_PATH`, `DATABASE_URL` were templated as `./...` defaults that shadowed the correct in-code defaults. Fresh installs and `memphis init`'s wizard templates now omit these — defaults kick in cleanly (`~/.memphis/...` for vault/embed/sqlite, `<installRoot>/crates/memphis-napi` for the bridge). Documented when to set them explicitly (always with absolute paths).
- **Backup pepper-restore writes to installRoot/.env** (#294) — `applyRestoredVaultPepper` now resolves `.env` via `resolveDotEnvPath()` instead of `${memphisRoot}/.env`. Pepper landed in a file the daemon never reads, silently breaking vault decryption after every cross-host restore. Integration test fixed to align with the install-root resolution path.

### Added

- **Provider-failure cause surfacing — truth-model rollout to providers/index.ts** (#312) — six silent `} catch {}` sites now log the cause via `logger.warn` (Ollama health/listModels, tool_call args parse for Ollama/Minimax/generic-OpenAI providers, vault-key resolution, fallback-chain provider construction). Caller-facing return shapes preserved. Operators now see WHY MiniMax was skipped before Ollama won the fallback.
- **TUI silent-exit instrumentation** (#313) — pre-spawn TTY check + suspiciously-fast-exit warning + `MEMPHIS_DEBUG=1` verbose mode. The launcher's existing error paths handle non-zero exits and signals; this captures the silent code-0-exit case that lets the Rust TUI bail during init without printing anything.
- **CLI operator-triage UX bundle** (#307) — `memphis ask "co jest"` now accepts positional input (no `--input` required); dispatcher prints "did you mean: memphis vault add" when operator types verb-first (`memphis add provider X`); `memphis provider add` pre-flights the Rust bridge BEFORE prompting for the API key (so operators don't type a secret into a doomed write); pino sonic-boom race fixed via `sync: true`. **Bundles 4 fixes from the operator's 2026-04-26 production log.**

## v1.7.0 - 2026-04-26

The 2026-04-26 sprint cycle — 22 merged PRs covering the gap-fill plan (Phases A-G) plus an
emergency operator-blocker fix that surfaced when running `memphis provider add minimax` from
$HOME. Headline: vault writes were broken outside the source checkout; both the symptom
(silent "Vault secret write failed") and the root cause (relative bridge path resolved against
`process.cwd()`) are fixed.

### Fixed

- **Vault bridge path anchored to install root, not cwd** (#306) — `getBridgePath()` now resolves through `resolveInstallRoot()`. Operator running `memphis` from any directory (e.g. `~`) no longer hits "Rust vault bridge not found at ./crates/memphis-napi". Previously broke every vault-touching command (`provider add`, `vault add`, `init`, boot integrity probe) outside the source checkout.
- **Vault secret-write surfaces underlying cause** (#305) — `storeVaultSecret` now wraps with `Error.cause` chain + writes `causeMessage`/`causeCode` to audit. Previously silent `} catch {}` hid all diagnostics; the operator saw "Vault secret write failed" with nothing actionable. Decrypt errors stay generic (oracle-defense — covered by existing `vault-boundary > returns generic decrypt errors and keeps audit metadata safe` test).
- **Pino log rotation** — `src/infra/logging/log-rotation.ts` rotates `~/.memphis/logs/memphis.log` at 10 MiB into gzipped archives under `archives/` and prunes to the 5 newest by mtime. Triggered pre-`pino.destination` open in `getFileStream()` so each restart starts on a fresh file. Tunable via `MEMPHIS_LOG_ROTATE_BYTES` (64 KiB–100 MiB), `MEMPHIS_LOG_ROTATE_KEEP` (1–100); opt-out via `MEMPHIS_LOG_ROTATE=disabled`. Closes the unbounded-growth gap that left `memphis.log` at 36 MiB on operator boxes after ~13 days.
- **MiniMax chat error names the actual failure mode** (#293) — when the `MINIMAX_API_KEY` resolves to nothing, the chat error now says "no API key available for minimax" instead of the generic "provider X chat failed".
- **VAULT-ref leak audit on voice + HTTP API auth** (#301) — `parseVoiceQuotaUsers` and HTTP API token reader pass `process.env.X` through `readResolvedSecret()` so unresolved `VAULT:keyname` values don't silently match nothing.
- **Backup pepper-restore writes to installRoot/.env** (#294) — `--pepper-restore` was writing to memphisRoot/.env, the wrong location; the daemon reads `.env` from installRoot.
- **Test flakes — env-bleed isolation** (#297) — pin `MEMPHIS_VAULT_STATE_PATH` and `MEMPHIS_VAULT_ENTRIES_PATH` in 3 test files that were tripping the double-init guard against the dev-host's real `~/.memphis/vault-state.json`.
- **Chat error names failing tools** (#309, Task #21) — when chat aborts on tool error-limit, the error message identifies which tool reached the limit.
- **Codex round 1 hardening** (#291) — strip 18 unused `eslint-disable` directives across `tests/unit/`. Zero lint warnings.

### Added

- **TUI `/reload` slash command** (#296, Phase A1) — drops in-process env-snapshot, re-reads `.env`, re-resolves providers. Lets `memphis vault add` post-startup become visible without bouncing the TUI.
- **TUI `/provider` `/model` persist to .env** (#308, Phase A2) — slash arms now write `DEFAULT_PROVIDER` / `MEMPHIS_DEFAULT_MODEL` to `<installRoot>/.env` so the choice survives restarts. Also added to `/help` discoverability.
- **TUI `/clear` drops chat history** (#299, Phase E2) — full `clear_output_and_history()` swaps `chat_session_id` to `tui-<unix-timestamp>`. Operator can reset context with one slash.
- **TUI `/reload` + `/provider` + `/model` discoverable in `/help`** — added entries with examples.
- **`memphis tier elevate` CLI** (#304) — symmetric counterpart to `memphis tier revoke`. Hidden TTY prompt or `MEMPHIS_OPERATOR_PASSPHRASE` env (memory rule: never accept passphrase as CLI flag). New `POST /v1/ops/tier3/elevate` endpoint.
- **`memphis vault migrate`** (#289) — moves legacy `data/vault-*.json` to `~/.memphis/vault-state.json` (the new default). Idempotent, logs the move.
- **TUI tier 0/1/2 dispatch parity with Telegram** (#284, S2) — TUI now matches Telegram's tier-gated dispatch.
- **Wire 7 registered-but-unwired tools** (#283, S1) — `memphis_*` tools that were registered but had no executor handler now run.
- **S3 self-awareness — runtime introspection** (#310) — new `memphis_self_describe` MCP tool, `GET /v1/ops/capabilities` HTTP endpoint, `memphis tools list/describe` CLI surfaces. Single source of truth for tool catalog across MCP/HTTP/CLI.
- **ContextOverflow distinct OperatorError variant** (#302, Phase E1) — provider 4xx context-overflow responses now map to `OperatorError::ContextOverflow { provider, tokens_used, context_window }` instead of generic "provider chat failed". Sets up TUI to render "use /clear to reset" hint.
- **Backup captures redacted `.env`** (#298, Phase C) — non-secret env entries (provider URLs, vault refs, runtime knobs) round-trip through `restore`. Operator no longer needs to manually re-run `vault add` after restore on a fresh host.
- **Voice install-script deps** (#300, Phase F) — `scripts/install-prerequisites.sh` adds `ffmpeg`, `libasound2-dev`, `zstd` (apt) and `ffmpeg-free`, `alsa-lib-devel`, `zstd` (dnf). New `docs/operator/voice-setup.md` runbook for HuggingFace + Whisper + MMS-TTS-Pol setup.
- **Fresh-install runbook** (#295) — `scripts/fresh-install/06-fresh-install-and-restore.sh` + bilingual README. Tested end-to-end against the USB watra-pack restore path.
- **As-intended sprint audit** (#292, S8) — 2026-04-26 sprint cycle audit doc.

### Changed

- **Dead code sweep** (#290, S5) — removed `openclaw-plugin/`, `legacy/tui-ts/`, and the `configure` command stub.

### Deferred to v1.7.1

- **S4 app.rs refactor** (#287) — 5-PR stack to extract `app.rs` into modules. Rebase against the recent app.rs additions (Phase A1 `/reload`, Phase A2 `/provider`/`/model`, Phase E2 `/clear`) became too tangled; will land as a fresh stack.
- **`memphis tier revoke` CLI portion of #288** — needs to be re-built on top of the post-#304 tier handler architecture.
- **Operator triage CLI UX bundle** (#307) — `ask` positional input, dispatcher "did you mean", pre-flight Rust bridge before secret prompt, sonic-boom race fix. Tests pass locally but CI is hitting an unrelated env-bleed flake; rolling into v1.7.1.

## v1.6.0 - 2026-04-23

Y1 Q1 foundation — compressed sprint shipped the write → export → train → verify loop end-to-end, ~6 weeks ahead of the Q1 calendar close (2026-07-31). Operators can exercise the full Kartograf distribution path today against the training stub; real Kartograf training replaces the stub body in Q2 without CLI or consumer changes.

### Added

- **N36 Kartograf spec** (#249) — `docs/dev/KARTOGRAF-SPEC.md` freezes ModernBERT-base + 256d embedding head + 12-class zone classifier + trust-tiered distribution model. Supersedes the WATRA-\* doc family.
- **N25 dep policy + CI gate** (#248) — `docs/dev/DEPENDENCY-POLICY.md`, `.github/pull_request_template.md`, `.github/workflows/dep-freeze-check.yml`. Symmetric diff over npm/Cargo/pip/vendor with per-block keys catches add/bump/remove uniformly; blocked class rejects outright.
- **N30 quarterly-gate workflow** (#248) — `.github/workflows/quarterly-gate.yml` + `scripts/quarterly-exit-test-q1.sh`. Runs on the real last Monday of each quarter-end month + `workflow_dispatch` with a `current` default choice.
- **N37 Kartograf corpus pipeline** (#251) — `tools/training/kartograf-corpus.py`. Realpath containment + denylist (broadened `.env*` / `*.env` / vault) + decoded-content secret scan + zone catalog alignment assertion (hard-fail). Produces `train.jsonl` + `eval.jsonl` + signed summary.
- **N8 turnId + consent propagation** (#250) — `storeDurableMemory` stamps `turn_id` + `consent` on every block. Per-surface `defaultConsent` policy with `MEMPHIS_SURFACE_<SURFACE>_DEFAULT_CONSENT` overrides.
- **N40 signed checkpoint envelope** (#255) — `src/kartograf/checkpoint.ts`. Canonical-JSON Ed25519 sign/verify via node:crypto. Graceful `{ valid: false, reason }` on malformed input.
- **N11 retroactive consent mark CLI** (#254) — `memphis consent mark --chain <name> --from-index <n> --level <exportable|local-only|anonymized>`. Appends a `consent.annotation` block that downstream consumers override by.
- **N9 trajectory exporter** (#253) — `memphis export trajectories --out <dir> [--since ISO] [--consent exportable|local-only|anonymized|all]`. Paginated chain reads, strict consent filter, session grouping via `conversation_id` → `session_id` → per-turn fallback, pre-filter chain-tip capture for integrity.
- **N40.2 `memphis kartograf` CLI** (#258) — `verify` + `install --source <tier>` subcommands. Verification failure blocks install; stale artifacts cleared before staging; `hf-hub`/`github-release`/`agora` gated as Y2+ transports.
- **N37.2 training harness stub** (#259) — `tools/training/train-kartograf.py`. Validates corpus invariants, writes placeholder ONNX + tokenizer, signs envelope byte-for-byte compatible with the TS verifier. CLI surface stable for Q2 real-training replacement.
- **N21 embed cascade primitive** (#256) — `EmbedMode::Cascade(Vec<EmbedMode>)` variant with nested composition + depth bound. Kartograf → nomic → local fallback chains become configurable when Kartograf ships.
- **N8.2 conversation_id + session_id plumbing** (#257) — write-side half of session grouping. `MemoryClient.store(…, { turnId, conversationId, sessionId })` threaded through turn-runtime so multi-turn conversations collapse into single trajectories. E2E integration test proves round-trip on disk.
- **N23 Bug 3 SEGV fix** (#252) — `embed_shutdown` NAPI export called from graceful-shutdown before `process.exit`. Closes the race between V8 teardown and the embed pipeline's `OnceLock<Mutex<EmbedPipeline>>`.
- **Y1 roadmap** (#246, #247) — `docs/roadmap/Y1-2026-05-to-2027-05.md` (Kartograf-track, reality-grounded). v1 archived to `docs/roadmap/archive/`.

### Changed

- **Q1 exit test rescoped** (#260) — `scripts/quarterly-exit-test-q1.sh` dropped `docs/dev/MV2-INTEGRATION.md` and `docs/dev/RLM-SAFETY-INVARIANTS.md` gates after the 2026-04-23 revised scope deferred N12 (.mv2 adapter) and RLM sandbox to Y2. Replaced with gates on the actually-shipped foundation: kartograf CLI, checkpoint envelope, training harness, consent mark CLI.

### Deferred (explicit, not oversight)

- **N12 .mv2 adapter** → Y2 when multi-consumer distribution justifies it. Kartograf ships via HF-hub + signed envelope (N40), not .mv2 bundles.
- **N13-sign** → follows N12.
- **N31 app.rs split** → Q2 refactor week per roadmap.

See `memory/project_y1_sprint2_revised_2026_04_23.md` for the scope-revision rationale.

## v1.5.0 - 2026-04-22

### Added

- `docs/operator/install-fresh-user.pl.md` — 20 KB Polish step-by-step install guide for first-time operators (zero prior Memphis knowledge assumed). Covers system deps, Node 22 / Rust / Ollama install, memphis init + doctor + service, verification, troubleshooting, glossary. Complementary to the canonical `operator/install.{en,pl}.md` which target experienced operators.
- `docs/dev/TRAJECTORY-EXPORT-V1.md` — design proposal for trajectory export v1 (schema, exporter CLI, consent model, HF-dataset output). Blocker-level proposal for the lab-pivot roadmap (replay/A-B, RLAIF reward, federation, tool-use dataset).

### Fixed

- `memphis vault add` env-var hang in `env -i` fresh-env contract (#244) — operator-gate reads `MEMPHIS_OPERATOR_PASSPHRASE` explicitly.
- `memphis skills` tool-registry validation against `TOOL_REGISTRY` (#245, Codex #242) — rejects declarations referencing unknown tools at manifest load time.
- `scripts/secret-scan.sh` api_key pattern required opening quote (false-positive on Rust function calls resolved).

## v1.4.0 - 2026-04-19

### Added

- Production sprint phases 1.1–3.2 (10 PRs, #119–#126):
  - Phase 1.1 — graceful SIGTERM/SIGINT drain
  - Phase 1.2 — scheduled backup + restore-drill + observability
  - Phase 1.3 — provider cost-cap as observable feature
  - Phase 2.1 — per-provider circuit breaker with observable state
  - Phase 2.2 — concurrent-turn admission with user-visible queue
  - Phase 2.3 — self-modify boot-failure auto-revert
  - Phase 3.1 — live Telegram smoke test (CLI + CI)
  - Phase 3.2 — chain schema migration framework
- **Phase L (#149/PR #162):** offline-invariant gate — lightweight PR-time test (`tests/integration/offline-invariant.test.ts`) + heavy nightly acceptance (`.github/workflows/offline-acceptance.yml` running `scripts/rc-drill.sh` in fresh isolated env). CI-enforces that Memphis remains operable without any remote-provider keys.
- **Phase A3 (PR #163):** Rust sanitizer workflow — ASan on `memphis-vault`, UBSan on `memphis-core`, TSan on `memphis-core`. workflow_dispatch + Sundays 03:00 UTC.
- **L3 ToolRegistry incremental polish (PR #164):** added optional `inputSchema?: z.ZodTypeAny` field to `ToolMeta` interface; pilot 5 tier-0 tools (memphis_journal, memphis_recall, memphis_search, memphis_decide, memphis_health) now expose strict Zod schemata for surface-side input validation.
- **Bilingual install + debug guides (PR #170, PR #171):** `docs/operator/install.{en,pl}.md` + `docs/operator/debug.{en,pl}.md` — canonical EN + PL entry points consolidating 5 prior install docs and adding a Symptom→Diagnosis→Fix tree covering 36 runtime issues across 8 categories.
- **Example installation walkthrough (PR #172):** `docs/operator/example-installation/` — 7 sanitized files showing happy-path install + first-run + chat + vault setup + health snapshot + timing baseline (Intel i3-2120 reference).
- **Crate READMEs + docs index (PR #173):** 7 new crate READMEs + rewritten `docs/README.md` index after the 4-bucket reorganization.
- **Dependency audit doc (PR #174):** `docs/dev/dependencies.md` — exhaustive list of system / npm / cargo deps with rationale per package.

### Fixed

- Codex Round 5 + Round 6 bundled hotfixes (#118, #127): 26 review findings closed across the production sprint.
- Security scan sprint 2026-04-17 — two bundled hotfixes (#141, #146) closed 20 findings total: SSRF in `memphis_web_fetch` (HIGH), `npm audit` upgrades (HIGH), `curl/wget --output` arbitrary file write (HIGH), `operator.json` PBKDF2 file mode 0o600 (HIGH), sync-manager unsigned-block rejection (HIGH), dashboard XSS escape (MED), dashboard `/api/data` Bearer token auth (MED), MCP transport loopback fail-closed (LOW), apps/manifest shell-quote (LOW), `two_factor.rs` Result error propagation (LOW), vault rotation tmp-file fsync before rename (LOW), and others.
- **Audit-trail hygiene (2026-04-19 sprint):** closed 15 OPEN security issues that were already fixed in PR #141 / PR #146 but had no `Closes #N` trailer (#129–#140, #143–#145).
- **Format drift recovery (PR #166):** `prettier --write .` on 328 files to recover the nightly-crystal "Format check" gate that had been failing for 8 consecutive days (2026-04-12 → 2026-04-19).
- **runtime-health defensive fix (PR #162):** `resolveSqlitePath` now handles undefined `DATABASE_URL` gracefully instead of crashing on `.startsWith` (surfaced while writing the Phase L offline-invariant test).
- **CI hygiene (PR #165):** bumped `actions/checkout` + `actions/setup-node` from v4 to v5 in `telegram-smoke.yml` to align with the rest of the workflow suite.

### Changed

- **Docs reorganization (PR #169):** `docs/` reorganized into 4 thematic subdirs — `operator/` (47 files), `dev/` (28 files), `agents/` (1 file), `historical/` (15 files). Pure relocations, no content modified.
- **Repo root cleanup (PR #168):** 12 stale `.md` files moved from repo root to `docs/archive/2026-04-19-root-cleanup/`. Root now has 13 operational/canonical files only.
- **Version sync (PR #167):** CHANGELOG + README brought into sync with `package.json` after a 3-way drift; this v1.4.0 entry follows that sync.
- **`.gitignore` (PR #174):** formalized `_Watra/`, `watra.zip`, `.claude/scheduled_tasks.lock`, `*.tmp`, `data/security-audit-archives/`, `data/vault-bak-*/` patterns that had been ad-hoc'd for weeks.

## v1.3.0 - 2026-04-06

### Added

- Native Anthropic provider with OAuth + API key auth.
- Full autonomy mode — all tools auto-approved without passphrase.
- One-liner `curl | bash` installer + post-install user flow.
- `memphis_test` tool (#52, #64) and `grep` / `glob` / `git` tools (#51, #53, #55) with expanded exec-policy allowlist.
- Voice messages (STT/TTS) for Telegram + `/evolve` command.
- Google Cloud TTS fallback for Polish voice.
- Bulletproof self-modify + cron tool + watchdog restart + file logging.
- MiniMax-M2.7 maxOutputTokens 4096 → 32768, context 204800.

### Fixed

- Atomic chain writes + propagate parse errors to prevent genesis overwrite (#70).
- Suppress restart timer under vitest to prevent uncaught exit.
- Self-modify path validation false positives (doctor-v2 ta8).
- Elevate `memphis_git`, `code_read`, `grep`, `glob`, `web_fetch` to tier 2 (vault passphrase required).
- Trust mode set command parser + `memphis_code_read` / `exec` in Rust operator.
- `run_sudo` strips `-E` when already root; remove dead tier-gate.

### Refactored

- `chain-file-io` extracted for shared block primitives.

## v1.2.4 - 2026-04-04

### Fixed

- `npm publish` idempotent on 409 Conflict to handle concurrent / re-run release jobs.

## v1.2.3 - 2026-04-03

### Fixed

- **Critical**: Add `sanitize_for_json()` in Rust operator (provider.rs) to fix DeepSeek 400 on TUI path. Previously sanitization only existed in TypeScript providers, but TUI uses Rust operator directly which bypassed it.

## v1.2.2 - 2026-04-03

### Fixed

- DeepSeek API 400 "unexpected end of hex escape" by adding `sanitizeForJsonRequest()` to sanitize invalid `\x` escape sequences in all provider message content.
- Provider stream JSON parsing crash ("expected value at line 1 column 1") by skipping empty SSE data payloads and SSE comment lines.
- Unhandled exception when LLM returns malformed JSON in `function.arguments` field — now safely falls back to empty object.
- Debug output verbosity in DeepSeek stream parsing (removed verbose eprintln statements).

## v1.2.1 - 2026-04-02

### Fixed

- Treat bounded `local-fallback` runtime as operational health after a clean first-run so RC/release drills do not fail closed just because Ollama is unavailable.
- Align the SQLite bootstrap schema-version assertion with the migrated runtime schema.

## v1.2.0 - 2026-04-01

### Added

- Cross-surface conversation identity so local operator and aliased chat surfaces can converge on one canonical conversation.
- Surface policy controls and operator UX for tiered chat surfaces with visible health and release gates.
- First-run status planning, runtime migration truth, and release acceptance coverage for `v1.2.0`.
- Repo-local Node and Rust launchers plus release smoke coverage for Rust workspace validation.

### Changed

- Release smoke now includes Rust workspace tests, isolated RC drill validation, and downloader-safe install checks.
- Prompt-risk handling degrades tools, recall, fetch, and durable writes before unsafe content can cross runtime boundaries.
- Runtime repair rebuilds embeddings from chain truth with chain-scoped memory IDs and canonical conversation mapping.

### Fixed

- Cross-user memory recall leakage in the gateway in-process memory client.
- Tool policy bypass between HTTP/chat runtime and SQLite-backed operator permissions.
- Cross-chain durable memory ID collisions and semantic recall chain-filter drift.
- Dashboard `/api/status` contract and auth mismatches.
- Curl-less bootstrap/install and TUI host stdout pollution that were breaking release drills.

## v1.1.1 - 2026-04-01

### Added

- Cognitive Architecture documentation (`docs/COGNITIVE-ARCHITECTURE.md`)
- Auto-approve Tier 2 tools in balanced cognitive mode
- Auto-obtain passphrase from secure file for self-modification
- Minimax added to provider cascade (Tier 3)

### Changed

- Gateway max_tool_calls increased from 16 to 64 for complex tasks
- Soul manifest preserves evolution settings including passphraseHash on ensureSoulManifest
- Onboarding always recommends 'memphis init' regardless of .env presence
- CLI dispatcher registers operator, evolve, secret, explain handlers
- Trust-cli tests updated for default 2 trustRules

### Fixed

- Corrupted files restored: soul.rs (Rust core), dispatcher.ts, telegram.handler.ts, manifest.ts
- GLM provider can now be fully disabled via GLM_ENABLED=false
- Provider cascade tier numbers corrected after adding minimax
- Legacy block shape migration for soul chain (run `memphis repair runtime` if needed)

## v1.1.0 - 2026-03-30

### Added

- Complete User Guide (`docs/USER-GUIDE.md`) covering all operator workflows
- Upgrade Guide (`docs/UPGRADE.md`) with v1.0.1 to v1.1.0 migration path
- Vault-first secret resolution for MiniMax, DeepSeek, GLM provider API keys
- Vault-first resolution for Pinata (IPFS) and alerting (PagerDuty, OpsGenie) secrets
- PULSE heartbeat watchdog startup in bootstrap with system chain health events
- System chain writes for boot events and health state changes
- Cognitive mode change events written to system chain and PULSE log
- TUI status bar shows cognitive mode (A-E) and PULSE health status
- TUI overview screen shows cognitive mode and PULSE health
- `/v1/cognitive/status` HTTP endpoint for cognitive mode, PULSE, and provider info
- `collective` and `patterns` added to KNOWN_CHAINS in soul manifest
- CHANGELOG.md v1.1.0 entry

### Changed

- TUI status bar format: `[Mode:A] provider/model · PULSE:healthy · session:id`
- README rewritten with cleaner Quick Start, feature table, architecture diagram
- Troubleshooting guide enhanced with quick decision tree and systemd fix
- Error messages: "Run memphis init" replaces "Run npm run bootstrap first"
- Telegram send tool uses `MEMPHIS_TELEGRAM_BOT_TOKEN` with legacy fallback
- Provider system file header moved below imports (lint fix)

### Fixed

- 5 test failures: updated expected messages and blocked command test
- ESLint errors: unused imports, import ordering, dead code removal
- Rust TUI: removed dead code (`render_view`, `separator`, `AppView`)
- Rust build: 0 warnings across entire workspace
- Pre-existing lint error in `providers/index.ts` (import group ordering)

### Removed

- Dead `computeBlockHash` function in chain-adapter.ts
- Dead `render_view` method and `AppView` struct in TUI
- Unused `InteractionSummary` import in soul/memory.ts

## v1.0.1 - 2026-03-28

- docs(cli): remove nonexistent gateway control commands
- docs(release): align final runtime contract
- feat(runtime): finalize local-first convergence
- test(cognitive): deflake model-c persistence coverage
- fix(ci): restore TypeScript test green
- chore(repo): snapshot remaining local updates
- docs(memory): add morning handoff snapshot
- feat(knowledge): add runtime seam and TUI query path
- fix(tui): close operator-proof and release-gate hardening
- fix(tui-host): support apps show --file on host path
- feat(tui): ship host-first Rust operator cockpit
- chore(openclaw): archive deprecated plugin and remove active doc path
- ... plus 2 additional commits.

## v1.0.0 - 2026-03-27

- fix(release): build package artifact in validator test
- chore(release): v1.0.0-rc.1
- fix(release): derive runtime version from package metadata
- chore(release): converge rc candidate path
- chore(release): harden fresh-env rc proof
- refactor(tui): archive legacy ts console
- chore(release): add rc drill and close release truth
- feat(runtime): close provider and prompt-security parity
- feat(tui): land native rust chat runtime
- feat(tui): move rust console onto native operator seam
- docs(roadmap): rebase rust tui around native operator seam
- feat(tui): start rust console foundation
- ... plus 136 additional commits.

## v1.0.0-rc.1 - 2026-03-27

- fix(release): derive runtime version from package metadata
- chore(release): converge rc candidate path
- chore(release): harden fresh-env rc proof
- refactor(tui): archive legacy ts console
- chore(release): add rc drill and close release truth
- feat(runtime): close provider and prompt-security parity
- feat(tui): land native rust chat runtime
- feat(tui): move rust console onto native operator seam
- docs(roadmap): rebase rust tui around native operator seam
- feat(tui): start rust console foundation
- feat(chain): ship export and execute branch cleanup
- docs(memory): refresh sprint progress snapshot
- ... plus 134 additional commits.

# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog principles and semantic versioning intent.

## v0.4.2 - 2026-03-25

### Added

- `SyncTransport` interface for transport-agnostic sync protocol
- `WebSocketTransport` with B1/B2 bug fixes (readyState check, listener cleanup)
- `MatrixTransport` for Matrix-based federation (Phase 1-2)
- `MatrixClient`, `MatrixRoom` federation module for Matrix homeserver integration

### Fixed

- `leaveRoom` URL bug (was `/join/{room}/leave`, correct: `/rooms/{room}/leave`)
- `WebSocketTransport.close()` vs `onMessage()` race condition (memory leak)
- `MatrixTransport` message handler cleanup in `close()`

### Security

- Matrix Federation infrastructure (Phase 1-2) — self-hosted only, no external providers
- TODO: Add HMAC-SHA256 signing for federation (Phase 2)

### Notes

- Matrix Federation v1: room-based sync via Matrix homeservers
- EC1-EC4 edge cases documented as TODOs (room discovery, reconnect, token refresh, dedupe)

## v0.4.0 - 2026-03-24

### Added

- Tag-based recall filtering for user-scoped memory (Sprint 13)
- Ollama embedding provider with nomic-embed-text 768-dim support
- MiniMax-M2.7 cloud provider with OpenAI-compatible endpoint routing
- Persistent file-based sessions in gateway (FileSessionStore wired in bootstrap)
- SOUL_PROVIDER env var for gateway provider override
- Ollama model, MiniMax, and SOUL_PROVIDER vars in .env.example

### Changed

- Default MiniMax model: abab5.5-chat → MiniMax-M2.7
- TUI left panel width: 68% → 78% for longer responses
- TUI scrollback buffer: 260 → 500 lines
- TUI stream animation limit: 720 → 2000 chars

### Fixed

- TUI flickering: cursor-home instead of full screen clear
- CaseChainAdapter now respects RUST_CHAIN_ENABLED=false (was ignoring it)
- Rust case_append return format mismatch (chain[] vs block)
- Stale version references in INSTALL.md and NPM-INSTALL.md

## v0.3.5 - 2026-03-23

### Added

- 10 env-configurable operational thresholds (chain rotation, snapshot pruning, heartbeat, reflection, rate limits)
- `MEMPHIS_TELEGRAM_TOKEN_OVERRIDE` for emergency alerting when vault is unavailable
- Vault V1→V2 migration audit logging via `writeSecurityAudit()`
- Task queue HTTP endpoints (`GET /api/tasks/status`, `GET /api/tasks/pending`)
- Trust-root downgrade rejection (`evaluateTrustRootDowngrade()`)
- `providers health` subcommand (space-separated, replaces colon syntax)

### Changed

- SystemD defaults: CPUQuota 200%→100%, MemoryMax 2G→1G (safe for 1-core/2GB VPS)
- Setup wizard validates provider connectivity before writing .env
- Ollama setup checks if configured embed model is pulled locally
- Bootstrap script shows prominent warning when new secrets are generated
- Provider health TUI hook returns `unknown` instead of fake `healthy`
- Version bump 0.3.4→0.3.5 across all source files and docs

### Fixed

- Stale `v0.2.0-beta.1` version references in INSTALL.md, NPM-INSTALL.md, API-REFERENCE.md
- README roadmap aligned with Phase A–H completion status
- CLI completion scripts now list `providers health` as subcommand

## v0.3.4 - 2026-03-21

- Merge the release-preflight fixes from PR #11.
- Switch release publishing to the package-first GitHub Release + GitHub Packages path.
- Keep the active operator/runtime docs aligned with the current memphis release flow.

## v0.3.3 - 2026-03-21

- Fix GitHub Actions workflow versions and release packaging path.

## [0.3.1] - 2026-03-21

### Changed

- Release prep: aligned package versioning and publication docs for the current `memphis` repository.
- Hardened release and publish gates to require explicit tags and the current release smoke path.

## [0.3.0-beta.3] - 2026-03-11

### Fixed

- process.argv undefined in test environments (fixes 27 failing tests)
- Vault cache key collision causing data corruption
- QueryBatcher race condition in concurrent flush operations
- Backup command routing (list/verify now work correctly)
- --help flag safety (no destructive actions)

### Added

- Security audit logging for /api/decide, /api/recall, /v1/vault/\* endpoints
- Global rate limiting in gateway (100 req/min)
- HNSW graph traversal search algorithm (5-6x faster)
- Memory usage optimization (119MB → 97MB, -18%)
- Debug command documentation (docs/DEBUG-COMMANDS.md)
- CLI command matrix (docs/CLI-COMMAND-MATRIX.md)
- Performance tuning guide (docs/PERFORMANCE-TUNING.md)

### Changed

- Node.js requirement standardized to >=20
- Documentation consolidated (single QUICKSTART.md)
- Chain routing consolidated to storage handler
- Debug handler consistency improved

### Performance

- Query latency: 0.533ms → 0.102ms (5x faster)
- Embed search: 0.611ms → 0.102ms (6x faster)
- Memory RSS: 119MB → 97.4MB (under 100MB target)

### Tests

- 307/307 passing (100%)
- Added regression tests for P0 bugs
- Added security coverage tests
- Added performance benchmark tests

---

## [1.0.0] - 2026-03-11

### Added

- Production documentation suite:
  - professional landing README
  - formal contributing guide
  - security policy and disclosure process
  - consolidated version changelog
- Release-ready operator and quality gate documentation references.
- Hardened contribution workflow with 3 commits + 1 PR discipline.

### Changed

- Documentation baseline moved from sprint notes to release-grade docs.
- Project positioning clarified as production local-first cognitive memory runtime.

### Security

- Formalized security reporting path and supported-version statement.
- Consolidated encryption and security control descriptions.

### Breaking changes

- None.

---

## [0.2.0-rc.2] - 2026-03

### Added

- Post-release freeze and release checklist artifacts.
- Additional closure and proof validation scripts.

### Changed

- Release hardening and operational readiness for production transition.

### Breaking changes

- None documented.

---

## [0.2.0-rc.1] - 2026-03

### Added

- Native closure and sovereignty smoke coverage expansion.
- External host proof and ledger status flows.

### Changed

- Maturity of phase-based release gates.

### Breaking changes

- None documented.

---

## [0.2.0-beta.1] - 2026-03-11

### Added

- Multi-agent sync MVP (`memphis sync:*`) for chain export, import, push, and pull workflows.
- Multi-tier caching for semantic retrieval and embedding-heavy paths.
- One-line installer (`scripts/install.sh`) and initial installation docs for Linux/macOS/WSL.
- Expanded user documentation (quickstart, install guides, OpenClaw integration).

### Changed

- Stabilized plugin packaging and install flow (`openclaw.extensions`, plugin build path fixes).
- Documentation baseline upgraded for beta readiness (README/INSTALL/NPM flow).

### Security

- P0 security hardening pass for timing-attack and DoS-risk reduction.
- Chain integrity and rollback/graceful degradation protections promoted in runtime behavior.

### Full feature delta since [0.1.0-alpha.1]

- Rust N-API bridge integration with chain runtime and broad test coverage.
- Vault cryptography path: Argon2id + AES-256-GCM foundation and recovery/DID work.
- Embedding/vector retrieval stack with cosine similarity, LRU/TTL caching, and benchmarks.
- Multi-turn ask→persist→recall flow with session recall APIs.
- HTTP API + MCP server tracks with expanded smoke/test scripts.
- Runtime hardening: policy controls, rate limiting, status/health observability, structured logging.
- Multi-agent sync MVP and beta-grade install/documentation pipeline.

### Breaking changes

- None.

---

## [0.1.0-alpha.4] - 2026-03

### Added

- Sprint 3 capabilities:
  - ask→persist→recall flow
  - session APIs (`GET /v1/sessions`, events recall)
  - provider failover cooldown policy
  - ops status endpoints (`/v1/ops/status`, `/ops/status`)

### Breaking changes

- None documented.

---

## [0.1.0-alpha.3] - 2026-03

### Added

- Sprint 2 capabilities:
  - CLI unification and entrypoint simplification
  - gateway integration with unified `AppError` mapping
  - provider runtime policy module for decentralized adapters
  - metrics collection and `/metrics` endpoints

### Breaking changes

- None documented.

---

## [0.1.0-alpha.2] - 2026-03

### Added

- Blueprint port baseline from primary reference artifacts.
- Core TypeScript runtime modules and migration safety scaffolding.
- Rust workspace and initial NAPI bridge exposure.

### Breaking changes

- None documented.

---

## [0.1.0-alpha.1] - 2026-03

### Added

- Initial `@memphis-chains/memphis` package scaffold.
- TypeScript project, build/test/lint toolchain, and CLI bin wiring.
- Early docs and release/planning artifacts.

### Breaking changes

- Initial pre-release baseline.
