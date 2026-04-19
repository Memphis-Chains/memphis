## Unreleased

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
