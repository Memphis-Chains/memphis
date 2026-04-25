## Unreleased

### Fixed

- **Pino log rotation** — `src/infra/logging/log-rotation.ts` rotates `~/.memphis/logs/memphis.log` at 10 MiB into gzipped archives under `archives/` and prunes to the 5 newest by mtime. Triggered pre-`pino.destination` open in `getFileStream()` so each restart starts on a fresh file. Tunable via `MEMPHIS_LOG_ROTATE_BYTES` (64 KiB–100 MiB), `MEMPHIS_LOG_ROTATE_KEEP` (1–100); opt-out via `MEMPHIS_LOG_ROTATE=disabled`. Closes the unbounded-growth gap that left `memphis.log` at 36 MiB on operator boxes after ~13 days.

## v1.6.0 - 2026-04-23

Y1 Q1 foundation — compressed sprint shipped the write → export → train → verify loop end-to-end, ~6 weeks ahead of the Q1 calendar close (2026-07-31). Operators can exercise the full Kartograf distribution path today against the training stub; real Kartograf training replaces the stub body in Q2 without CLI or consumer changes.

### Added

- **N36 Kartograf spec** (#249) — `docs/dev/KARTOGRAF-SPEC.md` freezes ModernBERT-base + 256d embedding head + 12-class zone classifier + trust-tiered distribution model. Supersedes the WATRA-* doc family.
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
