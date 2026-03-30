# Memphis

[![CI](https://github.com/Memphis-Chains/memphis/actions/workflows/ci.yml/badge.svg)](https://github.com/Memphis-Chains/memphis/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache%202.0-green.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933)](https://nodejs.org)
[![Rust](https://img.shields.io/badge/rust-stable-orange)](https://www.rust-lang.org)

Memphis is a local-first agent runtime with chain-backed memory, a Rust security core, and a TypeScript orchestration layer. It runs on your machine, keeps durable auditable memory in append-only chains, and gives the operator full sovereignty over identity, secrets, and tool authorization.

**Current version: `v1.1.0`** | **Status: operational but not stable**

## Quick Start

```bash
# Prerequisites: Node.js 22+, Rust stable, build-essential
# Source checkout plus bootstrap is the canonical full-runtime path
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
./scripts/bootstrap.sh        # Install deps, build Rust + TS, create .env
memphis init                   # Controlled first-run: passphrase, vault, identity
memphis health --json          # Verify everything works
memphis tui                    # Launch native operator console
```

See [Installation Guide](docs/INSTALLATION.md) for detailed prerequisites and platform notes.

## What Memphis Does

| Feature | Description |
|---------|-------------|
| **Chain Memory** | Append-only, SHA-256 signed chains for journal, decisions, reflections, cases, patterns, collective, and system events |
| **Vault** | AES-256-GCM + Argon2id encrypted secret storage. All API keys, tokens, and passphrases live here |
| **5 Cognitive Models** | Mode A (Capture), B (Inference), C (Prediction), D (Collective), E (Meta-Reflection) — toggleable per session |
| **Rust TUI** | single-view operator cockpit with live native chat streaming across seven logical native surfaces: Overview, Chat, Memory, Sessions, Vault, Cases, System |
| **MCP Server** | 15+ tools with tier-based authorization (Tier 0/1/2) |
| **Telegram Gateway** | Bidirectional: operator commands in, system events out. Vault-backed tokens via `setup matrix` |
| **Self-Modification** | Git snapshot + branch + test gate + approval. Tier 2 (vault passphrase) required |
| **Providers** | Ollama (local), MiniMax, DeepSeek, GLM, local-fallback. Automatic degradation |
| **ISKRA / MEMORY / PULSE** | Identity prompt, burn-after-action log, heartbeat monitor — the soul system |

## Architecture

```
Operator
  |
  +-- CLI (memphis <cmd>)          -- TypeScript, 58+ commands
  +-- Rust TUI (memphis tui)       -- Ratatui native console
  +-- HTTP API (:3000)             -- Fastify, token-authenticated
  +-- MCP Server                   -- JSON-RPC 2.0, tier-gated tools
  |
  +-- TypeScript Runtime (src/)
  |     +-- app/bootstrap.ts       -- Startup orchestration
  |     +-- cognitive/model-{a-e}  -- 5 cognitive engines
  |     +-- gateway/               -- Telegram, channels
  |     +-- security/              -- Tier gates, fail-closed policy
  |     +-- soul/                  -- ISKRA, MEMORY, PULSE
  |
  +-- Rust Core (crates/)
  |     +-- memphis-core           -- Chain integrity, Ed25519 signing
  |     +-- memphis-vault          -- AES-GCM encryption, Argon2 KDF
  |     +-- memphis-embed          -- Embeddings pipeline
  |     +-- memphis-tui            -- Native operator console
  |     +-- memphis-napi           -- Node.js bridge (N-API)
  |     +-- memphis-operator       -- Native chat runtime
  |     +-- memphis-case-index     -- Case chain indexing
  |
  +-- Storage
        +-- ~/.memphis/chains/     -- Append-only signed chains (source of truth)
        +-- data/memphis.db        -- SQLite indexes (derived, rebuildable)
        +-- data/vault-entries.json -- Encrypted secrets
```

## Tier Authorization

Memphis enforces three authorization tiers for all tool access:

| Tier | Auth Required | Examples |
|------|--------------|----------|
| **0** | None | journal, recall, health, case queries |
| **1** | API token | vault secrets, config writes, provider changes |
| **2** | Vault passphrase | source modification, tool install, branch ops |

## CLI Reference

```bash
# Health & diagnostics
memphis health --json            # Runtime health check
memphis doctor --json            # Deep diagnostic (chains, vault, providers)

# Memory & cognitive
memphis journal "note"           # Write to journal chain
memphis recall "query"           # Semantic memory search
memphis search "exact phrase"    # FTS5 exact search
memphis reflect                  # Trigger meta-cognitive reflection
memphis mode <A|B|C|D|E>        # Switch cognitive mode

# Vault & secrets
memphis secret set <key>         # Store encrypted secret
memphis secret get <key>         # Retrieve secret (requires passphrase)

# Providers
memphis provider list            # Show configured providers
memphis provider add <name>      # Add provider with API key

# Telegram
memphis telegram configure       # Set up bot token (stored in vault)
memphis telegram status          # Check gateway readiness
memphis telegram send            # Send message to operator

# Sessions
memphis session list             # Show all sessions
memphis session new              # Create new session

# System
memphis tui                      # Launch native Rust console
memphis service install          # Install systemd user service
memphis backup                   # Backup chains and state
memphis evolve                   # Self-modification (tier 2)
```

## Configuration

Memphis uses `.env` for non-secret configuration and vault for all secrets.

Key settings in `.env`:

```dotenv
# Core
NODE_ENV=production
DEFAULT_PROVIDER=ollama              # ollama | local-fallback | minimax | deepseek | glm
DATABASE_URL=file:./data/memphis.db
RUST_CHAIN_ENABLED=true

# Ollama (local LLM)
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=cogito:3b
RUST_EMBED_MODE=ollama               # ollama | local (32-dim fallback)

# Identity
MEMPHIS_AGENT_NAME=Memphis Agent
MEMPHIS_OWNER_NAME=local operator

# Channels
MEMPHIS_CHANNEL_GATEWAY_ENABLED=false
```

All API keys and tokens go through vault:
```bash
memphis provider add minimax --api-key <your-key>   # Stores in vault
memphis telegram configure --bot-token <token>       # Stores in vault
```

See [.env.example](.env.example) for the full list.

## Development

```bash
npm run build              # Build Rust + TypeScript
npm run typecheck          # TypeScript --noEmit
npm run lint               # ESLint
npm run format:check       # Prettier validation
npm run test:ts            # Vitest suite
npm run test:rust          # cargo test --workspace
npm run -s cli -- doctor   # Deep health check
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `memphis` not found | Run `npm link` from repo root, then `hash -r` |
| Rust build fails | `sudo apt install build-essential pkg-config libssl-dev` |
| Ollama not available | `curl http://127.0.0.1:11434/api/tags` — install Ollama if missing |
| Chain integrity error | `memphis doctor --json` — check `chains` section |
| Vault locked | Re-enter passphrase via `memphis init` or `memphis secret get <key>` |

See [Troubleshooting Guide](docs/TROUBLESHOOTING.md) for detailed decision trees.

## Documentation

| Doc | Purpose |
|-----|---------|
| [Clean Install](docs/CLEAN-INSTALL.md) | Canonical install path from source |
| [Installation](docs/INSTALLATION.md) | Prerequisites, install, verify |
| [User Guide](docs/USER-GUIDE.md) | Complete operator manual |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Debug, fix, recover |
| [Architecture](docs/CANONICAL-ARCHITECTURE.md) | System boundaries and layers |
| [Project Status](docs/PROJECT-STATUS.md) | Current state and maturity |
| [Roadmap](docs/ROADMAP-CURRENT.md) | Current roadmap and milestones |
| [Upgrade Guide](docs/UPGRADE.md) | Migration between versions |
| [Release Process](docs/RELEASE-PROCESS.md) | CI/CD and release workflow |

## Future Integration

Memphis is designed with open integration paths:

- **Memphis Language (ML)**: A Lisp-like language for hardware control and inter-agent communication. The `ml-memphis` crate writes to Memphis chains. Integration path documented but deferred.
- **Matrix Federation**: Optional self-hosted Synapse for agent federation. Pilot config at `compose/matrix.yaml`. Not a core dependency.

## Release And CI Reference

### Release Candidate Path

Prepare release candidate (version bump, changelog, draft release):
```bash
./scripts/prepare-release-candidate.sh --version 1.0.0-rc.1
```

This creates a draft release via `.github/workflows/release-draft-dispatch.yml` without tagging or publishing.

Final GA release (tags, publishes package):
```bash
./scripts/release.sh --version 1.0.0
```

This runs `.github/workflows/release.yml` to publish to npm.

### CI Preflight Gates

<a id="ci-preflight-failure-triage-map"></a>

CI/release preflight failures map by gate id to runbook anchors: `docs/runbooks/RELEASE.md#ci-preflight-gate-<gate-id>`

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
- `validator-metadata.json` — preflight gate status, checksums
- `validator-metadata.json.sha256` — artifact checksum

Key output environment controls:
- `MEMPHIS_RELEASE_PREFLIGHT_GATE_OUTPUT`
- `MEMPHIS_STRICT_HANDOFF_GATE_OUTPUT`

Key preflight output keys: `preflight_summary_json`, `preflight_gate_ids`, `check_order_status`, `check_ids`

Validate release-draft fixture schemas:
```bash
npm run -s ops:validate-release-draft-validator-metadata -- \
  --metadata-path tests/fixtures/release-draft/validator-metadata-invalid-preflight-gate.json
npm run -s ops:validate-release-draft-validator-metadata -- \
  --metadata-path tests/fixtures/release-draft/validator-metadata-preflight-failure-example.json
```

Fixture references:
- `tests/fixtures/release-draft/validator-metadata.schema.json`
- `tests/fixtures/release-draft/validator-metadata-example.json`
- `tests/fixtures/release-draft/validator-metadata-preflight-failure-example.json`
- `tests/fixtures/release-draft/validator-metadata-invalid-preflight-gate.json`

preflight strict JSON gate script: `./scripts/strict-handoff-validator-json-gate.sh`

fallback strict JSON gate script: `./scripts/strict-handoff-validator-json-gate.sh`

Helper script: `scripts/ci-release-preflight-gate.sh`

Quality gates run in this workflow:
- bash ./scripts/run-release-gates.sh

Release checklist:
1. Run `npm run -s ops:release-preflight -- --json`
2. verify draft release body and links
3. confirm checksum in draft notes matches uploaded `.sha256` file
4. publish draft release when approved

Checksum patterns: `*.sha256`

Tag guidance: Use `vX.Y.Z` format for all releases.

### Strict Handoff Validation

Validate incident handoff fixtures:
```bash
npm run -s ops:validate-strict-handoff-fixtures -- --json
```

Fixture references:
- `tests/fixtures/strict-handoff/output-contract.json`
- `tests/fixtures/strict-handoff/summary.schema.json`
- `tests/fixtures/strict-handoff/completion-hints.schema.json`
- `tests/fixtures/strict-handoff/validator-output-contract.json`
- `tests/fixtures/strict-handoff/summary-example-preflight.json`
- `tests/fixtures/strict-handoff/completion-hints-example.json`
- `tests/fixtures/strict-handoff/failure-preflight.json`
- `tests/fixtures/strict-handoff/failure-export.json`
- `tests/fixtures/strict-handoff/failure-verify.json`

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0 — see [LICENSE](LICENSE)
