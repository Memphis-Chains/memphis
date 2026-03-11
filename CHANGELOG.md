# Changelog

All notable changes to this project are documented in this file.

The format follows Keep a Changelog principles and semantic versioning intent.

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

- Initial `@memphis-chains/memphis-v5` package scaffold.
- TypeScript project, build/test/lint toolchain, and CLI bin wiring.
- Early docs and release/planning artifacts.

### Breaking changes

- Initial pre-release baseline.
