# Memphis

Sovereign AI agent runtime with persistent memory, chain-backed audit trail, and safe self-modification.

Memphis combines a **Rust core** (cryptographic chain integrity, encrypted vault, HNSW embeddings) with a **TypeScript runtime** (orchestration, CLI, TUI, HTTP API, MCP server) to create an AI agent that remembers, reasons, and evolves — all on your local machine.

## Features

- **Persistent Soul** — agent identity, capabilities, and user preferences survive across sessions and restarts
- **Chain-Backed Memory** — every action is recorded in append-only, SHA-256 hash-linked chains validated by Rust
- **Semantic Recall** — Rust HNSW pipeline with Ollama embeddings for fast similarity search across all stored knowledge
- **Case-Based Reasoning** — 8 Polish grammatical cases (Nominative through Vocative) encode semantic relationships in a queryable knowledge graph
- **Encrypted Vault** — AES-256-GCM with Argon2id key derivation for secret storage
- **Tiered Authorization** — tier 0 (no auth), tier 1 (API token), tier 2 (vault passphrase) for progressive access control
- **Safe Self-Modification** — source changes require git snapshot, isolated branch, and passing tests before commit
- **Provider-Agnostic** — local models (Ollama) and cloud APIs (MiniMax, DeepSeek) via a pluggable registry
- **Operator-First** — all data on your machine, 40+ CLI commands, TUI dashboards, HTTP API, MCP server

## Quick Start

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
npm run bootstrap
```

Bootstrap handles dependencies, builds Rust + TypeScript, generates secrets, seeds agent identity, and installs the systemd service.

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

# Open the TUI (in another terminal)
npm run -s cli -- tui
```

For detailed setup (Node.js, Rust, Ollama), see **[INSTALL.md](INSTALL.md)**.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  TypeScript Runtime                             │
│  gateway · CLI · TUI · HTTP · MCP · providers   │
├─────────────────────────────────────────────────┤
│  Rust NAPI Bridge                               │
├──────────┬──────────┬──────────┬────────────────┤
│  core    │  vault   │  embed   │  case-index    │
│  chains  │  AES-GCM │  HNSW   │  SQLite        │
└──────────┴──────────┴──────────┴────────────────┘
```

**Rust crates** (`crates/`):

- `memphis-core` — chain integrity, deterministic replay
- `memphis-vault` — encrypted secret storage (AES-256-GCM, Argon2id)
- `memphis-embed` — HNSW vector index for semantic recall
- `memphis-napi` — Node.js NAPI bridge exposing Rust to TypeScript

**TypeScript runtime** (`src/`):

- `app/` — bootstrap, DI container
- `infra/cli/` — 40+ CLI commands and handlers
- `infra/http/` — Fastify HTTP server and routes
- `infra/storage/` — SQLite repositories, chain adapters
- `soul/` — identity manifest, persistent memory, seeding
- `cognitive/` — cognitive engine components
- `bridges/` — MCP native gateway
- `tui/` — terminal UI dashboards
- `security/` — fail-closed policy enforcement

## Soul System

Memphis agents have a three-tier identity:

1. **Manifest** (`soul-manifest.json`) — auto-generated from runtime state: tools, chains, providers, channels
2. **Memory** (`soul-memory.json`) — learned knowledge: user preferences, self-assessments, active context
3. **Chains** — foundational journal entries (identity, architecture, capabilities, boundaries) and 8 case entries encoding semantic self-knowledge

Soul seeding runs automatically on first boot. Verify with:

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

# Semantic recall
curl -X POST http://127.0.0.1:3000/api/recall \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query":"test memory","limit":5}'
```

## Documentation

- **[docs/README.md](docs/README.md)** — documentation index and governance
- **[docs/EXECUTION-PLAN.md](docs/EXECUTION-PLAN.md)** — master canonical roadmap to `v1.0.0`
- **[INSTALL.md](INSTALL.md)** — full installation guide
- **[docs/CANONICAL-ARCHITECTURE.md](docs/CANONICAL-ARCHITECTURE.md)** — system architecture
- **[docs/RUNTIME-SECURITY-ARCHITECTURE.md](docs/RUNTIME-SECURITY-ARCHITECTURE.md)** — runtime dependency graph and trust boundaries
- **[docs/NAPI-CONTRACT-V1.md](docs/NAPI-CONTRACT-V1.md)** — Rust-TypeScript bridge contract
- **[docs/RELEASE-PROCESS.md](docs/RELEASE-PROCESS.md)** — release workflow
- **[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)** — common issues and fixes

Memphis core is standalone. OpenClaw and Synjar remain optional downstream integration surfaces, not required dependencies for Memphis correctness or `v1.0.0`. The GA path is defined by runtime hardening, vault and persistence security, converged operator surfaces, and release readiness, not by downstream integrations or provider growth.

## Release and CI Reference

Canonical release runbook: `docs/runbooks/RELEASE.md`

- release preflight: `npm run -s ops:release-preflight -- --json`
- workflow: `.github/workflows/release-draft-dispatch.yml`
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
