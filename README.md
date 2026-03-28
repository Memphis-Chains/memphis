# Memphis

Local-first agent runtime with persistent memory, chain-backed audit trail, and safe self-modification.

Memphis combines a **Rust core** (cryptographic chain integrity, encrypted vault, HNSW embeddings, native operator console) with a **TypeScript runtime** (orchestration, CLI, HTTP API, MCP server) to create a local operator agent that remembers, reasons, and stays auditable on your machine.

## Features

- **Persistent Profile + Memory** — agent identity, capabilities, and operator preferences survive across sessions and restarts
- **Chain-Backed Memory** — every action is recorded in append-only, SHA-256 hash-linked chains validated by Rust
- **Hybrid Recall** — semantic recall via Rust HNSW plus exact phrase search via derived SQLite FTS5 index
- **Chain-First Cognition** — the runtime automatically searches local chains before and after each turn, using Model B/C context in the live agent loop
- **Case-Based Reasoning** — 8 Polish grammatical cases (Nominative through Vocative) encode semantic relationships in a queryable knowledge graph
- **Encrypted Vault** — AES-256-GCM with Argon2id key derivation for secret storage
- **Tiered Authorization** — tier 0 (no auth), tier 1 (API token), tier 2 (vault passphrase) for progressive access control
- **Safe Self-Modification** — source changes require git snapshot, isolated branch, and passing tests before commit
- **Provider-Agnostic** — local models (Ollama) and cloud APIs (MiniMax, DeepSeek) via a pluggable registry
- **Operator-First** — all data on your machine, 40+ CLI commands, native Rust TUI, HTTP API, MCP server

## Quick Start

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
npm run bootstrap
```

Bootstrap handles dependencies, builds Rust + TypeScript, generates secrets, initializes the local agent profile and baseline memory, and installs the systemd service.

```bash
# Initialize the encrypted vault
npm run -s cli -- vault init \
  --passphrase "your-secret" \
  --recovery-question "your question" \
  --recovery-answer "your answer"

# Verify installation
npm run -s cli -- doctor --fix
npm run -s cli -- health --json

# Start the runtime
npm run dev

# Open the Rust TUI (in another terminal)
npm run -s cli -- tui
```

Optional bounded Matrix pilot bootstrap:

```bash
npm run -s cli -- setup matrix --json
```

`setup matrix` stores pilot bootstrap secrets in the local vault. It only emits
`MEMPHIS_MATRIX_ACCESS_TOKEN=VAULT:MEMPHIS_MATRIX_ACCESS_TOKEN` when Memphis
acquires a real Matrix access token; otherwise it returns manual follow-up steps
instead of inventing pilot readiness.

Supported baseline: Node.js `22 LTS` or newer.

The canonical full-runtime GA path remains source checkout plus `npm run bootstrap`.
GitHub Releases and GitHub Packages publish the package artifact and bounded CLI
distribution surface; the primary full-runtime operator path stays source
checkout plus bootstrap.
GitHub remains a manual secondary lane for backup, review, and CI. Local chains
and local runtime state remain the canonical memory source of truth.

For detailed setup (Node.js, Rust, Ollama), see **[INSTALL.md](INSTALL.md)**.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  TypeScript Runtime                             │
│  gateway · CLI · HTTP · MCP · providers         │
├─────────────────────────────────────────────────┤
│  Rust Native Layer                              │
├──────────┬──────────┬──────────┬────────────────┤
│  core    │  vault   │  embed   │  tui          │
│  chains  │  AES-GCM │  HNSW    │  console      │
└──────────┴──────────┴──────────┴────────────────┘
```

**Rust crates** (`crates/`):

- `memphis-core` — chain integrity, deterministic replay
- `memphis-vault` — encrypted secret storage (AES-256-GCM, Argon2id)
- `memphis-embed` — HNSW vector index for semantic recall
- `memphis-operator` — native operator service layer for the Rust console
- `memphis-tui` — native operator console on top of the Rust operator seam
- `memphis-napi` — Node.js NAPI bridge exposing Rust to TypeScript while the TypeScript runtime remains in service

**TypeScript runtime** (`src/`):

- `app/` — bootstrap, DI container
- `infra/cli/` — 40+ CLI commands and handlers
- `infra/http/` — Fastify HTTP server and routes
- `infra/storage/` — SQLite repositories, chain adapters
- `soul/` — identity manifest, persistent memory, baseline seeding
- `cognitive/` — cognitive engine components
- `bridges/` — MCP native gateway
- `security/` — fail-closed policy enforcement

Archived legacy reference:

- `legacy/tui-ts/` — archived TypeScript TUI source and tests, no longer part of the active product or validation path

## Identity and Memory

Memphis agents have a three-tier identity:

1. **Manifest** (`soul-manifest.json`) — auto-generated from runtime state: tools, chains, providers, channels
2. **Memory** (`soul-memory.json`) — learned knowledge: user preferences, self-assessments, active context
3. **Chains** — foundational journal entries (identity, architecture, capabilities, boundaries) and 8 case entries encoding semantic self-knowledge

`soul-*` remains the compatibility name for these runtime surfaces. It is not the canonical product definition.

The primary memory contract is chain-first:

- `journal`, `decisions`, `reflections`, and `cases` are the canonical local cognitive inputs
- derived recall indexes and helper files are rebuildable support surfaces
- git/GitHub history is optional review context, not the runtime memory source of truth

Baseline seeding runs automatically on first boot. Verify with:

```bash
npm run -s cli -- soul show
```

## Development

```bash
npm run build              # Build Rust + TypeScript
npm run typecheck           # TypeScript --noEmit
npm run lint                # ESLint
npm run test:ts             # Vitest suite
npm run test:rust           # cargo test --workspace
npm run test:chaos          # WAL chaos gate
npm run -s cli -- doctor    # Runtime diagnostics
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) — `feat(cli):`, `fix(vault):`, `test(ops):`.

## HTTP API

```bash
TOKEN=$(grep '^MEMPHIS_API_TOKEN=' .env | cut -d= -f2-)

# Health check
curl http://127.0.0.1:3000/health

# Store a memory
curl -X POST http://127.0.0.1:3000/api/journal \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"content":"test memory","tags":["test"]}'

# Semantic recall: "what do I know about this?"
curl -X POST http://127.0.0.1:3000/api/recall \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query":"test memory","limit":5}'

# Exact recall: "where is this mentioned?"
curl -X POST http://127.0.0.1:3000/api/search \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query":"test memory","limit":5,"chain":"journal"}'

# Semantic recall
curl -X POST http://127.0.0.1:3000/api/recall \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query":"test memory","limit":5}'
```

## Documentation

- **[docs/README.md](docs/README.md)** — documentation index and governance
- **[docs/EXECUTION-PLAN.md](docs/EXECUTION-PLAN.md)** — canonical `v1.0.0` delivery record and post-GA baseline
- **[INSTALL.md](INSTALL.md)** — full installation guide
- **[docs/CANONICAL-ARCHITECTURE.md](docs/CANONICAL-ARCHITECTURE.md)** — system architecture
- **[docs/RUNTIME-STATE-MODEL.md](docs/RUNTIME-STATE-MODEL.md)** — canonical runtime roots, cleanup semantics, and fresh-install contract
- **[docs/RUNTIME-SECURITY-ARCHITECTURE.md](docs/RUNTIME-SECURITY-ARCHITECTURE.md)** — runtime dependency graph and trust boundaries
- **[docs/NAPI-CONTRACT-V1.md](docs/NAPI-CONTRACT-V1.md)** — Rust-TypeScript bridge contract
- **[docs/RELEASE-PROCESS.md](docs/RELEASE-PROCESS.md)** — release workflow
- **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** — common issues and fixes

Memphis core is standalone. OpenClaw remains a deprecated downstream trace, while Matrix federation pilot work and Synjar remain optional bounded extension surfaces, not required dependencies for Memphis correctness or `v1.0.0`. The GA path is defined by runtime hardening, vault and persistence security, a native Rust operator console, converged operator surfaces, and release readiness, not by downstream integrations or provider growth.

For the Rust console, the active `v1.0.0` seam is now `memphis-tui -> memphis-operator -> Rust crates`. The interactive Rust TUI is now a single-view operator cockpit with live native chat streaming and seven logical native surfaces: Overview, Chat, Memory, Sessions, Vault, Cases, and System. The old TypeScript TUI now lives only under `legacy/tui-ts/` as archived reference material.

## Release and CI Reference

Canonical release runbook: `docs/runbooks/RELEASE.md`

- canonical RC prep: `./scripts/prepare-release-candidate.sh --version 1.0.0-rc.1`
- release preflight: `npm run -s ops:release-preflight -- --json`
- canonical RC workflow: `.github/workflows/release-draft-dispatch.yml`
- final GA tag/publish workflow: `.github/workflows/release.yml`
- helper gate wrapper: `scripts/ci-release-preflight-gate.sh`
- strict fixture validator: `npm run -s ops:validate-strict-handoff-fixtures`
- fallback strict JSON gate script: `./scripts/strict-handoff-validator-json-gate.sh`
- preflight strict JSON gate script: `./scripts/strict-handoff-validator-json-gate.sh`
- fallback guard drill gate script: `./scripts/guard-drill-json-gate.sh`
- validator fixtures:
  - `tests/fixtures/release-draft/validator-metadata.schema.json`
  - `tests/fixtures/release-draft/validator-metadata-example.json`
  - `tests/fixtures/release-draft/validator-metadata-preflight-failure-example.json`
  - `tests/fixtures/release-draft/validator-metadata-invalid-preflight-gate.json`
- strict-handoff fixtures:
  - `tests/fixtures/strict-handoff/output-contract.json`
  - `tests/fixtures/strict-handoff/summary.schema.json`
  - `tests/fixtures/strict-handoff/completion-hints.schema.json`
  - `tests/fixtures/strict-handoff/validator-output-contract.json`
  - `tests/fixtures/strict-handoff/summary-example-preflight.json`
  - `tests/fixtures/strict-handoff/completion-hints-example.json`
  - `tests/fixtures/strict-handoff/failure-preflight.json`
  - `tests/fixtures/strict-handoff/failure-export.json`
  - `tests/fixtures/strict-handoff/failure-verify.json`

Release draft workflow artifacts also include:

- `validator-metadata.json`
- `validator-metadata.json.sha256`
- `*.sha256`
- shared preflight output keys: `preflight_summary_json`, `preflight_gate_ids`, `check_order_status`, `check_ids`
- strict output env controls: `MEMPHIS_RELEASE_PREFLIGHT_GATE_OUTPUT`, `MEMPHIS_STRICT_HANDOFF_GATE_OUTPUT`
- validator metadata debug:

```bash
npm run -s ops:validate-release-draft-validator-metadata -- \
  --metadata-path tests/fixtures/release-draft/validator-metadata-invalid-preflight-gate.json

npm run -s ops:validate-release-draft-validator-metadata -- \
  --metadata-path tests/fixtures/release-draft/validator-metadata-preflight-failure-example.json
```

- review draft before publish:
  - verify draft release body and links
  - confirm checksum in draft notes matches uploaded `.sha256` file
  - publish draft release when approved

Manual fallback:

```bash
npm run -s lint
npm run -s typecheck
./scripts/guard-drill-json-gate.sh
npm run -s ops:validate-strict-handoff-fixtures
./scripts/strict-handoff-validator-json-gate.sh
npm run -s test:ops-artifacts
npm run -s test:ts
npm run -s test:chaos
npm run -s test:rust
npm pack --dry-run
mkdir -p release-dist
npm pack --pack-destination release-dist
sha256sum release-dist/memphis-chains-memphis-<version>.tgz
git tag -a vX.Y.Z -m "Memphis vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

Draft release workflow artifacts also include:

- rerun strict fixture validator in JSON mode: `npm run -s ops:validate-strict-handoff-fixtures -- --json`
- rerun gates individually when preflight reports a failing gate id:
  - `npm run -s lint`
  - `npm run -s typecheck`
  - `./scripts/guard-drill-json-gate.sh`
  - `npm run -s ops:validate-strict-handoff-fixtures -- --json`
  - `./scripts/strict-handoff-validator-json-gate.sh`
  - `npm run -s test:ops-artifacts`
  - `npm run -s test:ts`
  - `npm run -s test:chaos`
  - `npm run -s test:rust`

CI/release preflight failures map by gate id to runbook anchors:

- `docs/runbooks/RELEASE.md#ci-preflight-failure-triage-map`
- `docs/runbooks/RELEASE.md#ci-preflight-gate-<gate-id>`
- anchor token: `ci-preflight-gate-`

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT
