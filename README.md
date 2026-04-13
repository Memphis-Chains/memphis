# Memphis

[![CI](https://github.com/Memphis-Chains/memphis/actions/workflows/ci.yml/badge.svg)](https://github.com/Memphis-Chains/memphis/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache%202.0-green.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933)](https://nodejs.org)
[![Rust](https://img.shields.io/badge/rust-stable-orange)](https://www.rust-lang.org)

**Sovereign AI that runs on your machine, remembers in chains you own, and answers to no one but you.**

Memphis is a local-first cognitive runtime born from [Oswobodzeni](https://oswobodzeni.pl) — a movement for digital sovereignty where citizens, not corporations, control their data, identity, and tools. In a world where AI lives in someone else's cloud, Memphis is the opposite: an agent runtime you install on your own hardware, with memory sealed in append-only cryptographic chains, secrets locked in a vault only you can open, and zero telemetry going anywhere.

Every decision Memphis makes is recorded. Every secret is encrypted at rest. Every tool it touches requires your authorization. This is not a chatbot — it is a sovereign cognitive system designed for operators who refuse to rent their intelligence from Big Tech.

**Current version: `v1.2.1`** | **Status: operational but not yet broadly stable**

---

## Why Memphis Exists

Technology can be chains or keys. The centralized AI model — where your conversations, your data, your business logic live on someone else's servers, governed by someone else's policies — is a sovereignty problem. Memphis solves it:

- **Your machine, your memory.** Nothing leaves your hardware unless you explicitly send it.
- **Chain-backed truth.** Every journal entry, decision, reflection, and system event is written to append-only SHA-256 signed chains. No silent edits. No disappearing history.
- **Vault-sealed secrets.** AES-256-GCM + Argon2id encryption. API keys, tokens, passphrases — everything lives in a vault that requires your passphrase to unlock.
- **Provider independence.** Run local models via Ollama, or connect to MiniMax, DeepSeek, GLM. If one goes down, Memphis cascades to the next. If all go down, the local fallback keeps you running.
- **Self-modification under your control.** Memphis can evolve its own code — but only through a gated process: git snapshot, branch, test suite, your approval. Tier 2 vault passphrase required.

This is the AI infrastructure layer for the digitally sovereign nation. Memphis is the brain. The chains are the memory. The vault is the trust boundary. You are the operator.

---

## Quick Start

**One-liner install** (Linux / macOS / WSL) — installs Node 22, Rust stable, build tools, clones the repo, builds everything, and links the `memphis` CLI globally:

```bash
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash
```

No soul state, no vault, no agent identity is created by the installer — first-run is a deliberate step. After install, run these commands in order:

```bash
memphis init              # passphrase, vault, identity, first chain writes
memphis doctor            # verify everything is healthy
memphis service install   # install & enable systemd user service
memphis service restart   # start (or restart) the runtime
memphis tui               # open the native operator console
```

That's it. Sovereign AI, on your machine, with encrypted vault, chain memory, and a native terminal cockpit.

### CLI cheat sheet

| What you want | Command |
|---|---|
| First-run (passphrase + vault + identity) | `memphis init` |
| Health check | `memphis health` |
| Diagnose + auto-repair | `memphis doctor --fix` |
| Start / stop / restart daemon | `memphis service {start,stop,restart}` |
| Daemon status | `memphis service status` |
| Recent daemon logs | `memphis service logs -n 100` |
| Open native TUI console | `memphis tui` |
| List configured providers | `memphis providers list` |
| Inspect vault | `memphis vault list` |
| Add a vault secret | `memphis vault add <key>` |
| Store a memory | `memphis journal "<text>"` |
| Semantic recall | `memphis recall "<query>"` |
| Exact search (FTS5) | `memphis search "<phrase>"` |
| Agent self-modification log | `memphis evolve log` |

Run `memphis --help` for the full surface.

### Manual install

Prefer a source-checkout + bootstrap workflow? See [INSTALL.md](./INSTALL.md) for step-by-step manual instructions, or [docs/CLEAN-INSTALL.md](./docs/CLEAN-INSTALL.md) for the canonical source checkout path used by contributors (`git clone` + `npm run bootstrap`).

You can also audit the installer without running it:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh) --check-only --json
```

---

## What Memphis Does

| Capability | What It Means |
|-----------|---------------|
| **Chain Memory** | 7 append-only, SHA-256 signed chains: journal, decisions, reflections, cases, patterns, collective, system. Session memory and conversation compaction now sit on top as derived overlays, not separate memory truths. |
| **Encrypted Vault** | AES-256-GCM + Argon2id. All API keys, tokens, and passphrases live here. Not in `.env`. Not in plaintext. In the vault. |
| **5 Cognitive Modes** | A (Capture), B (Inference), C (Prediction), D (Collective), E (Meta-Reflection). Toggle per session. Each writes to its own chain. |
| **Rust TUI** | Native operator cockpit with live chat streaming, transcript scrollback, wrapped output, busy animation, token/context telemetry, and pressure visibility across Overview, Chat, Memory, Sessions, Vault, Cases, System. |
| **MCP Server** | Shared runtime tool lane with factory-backed tool registry, bounded concurrency for safe tools, and tier-based authorization (Tier 0/1/2). |
| **Telegram Gateway** | Bidirectional: operator commands in, system events out. Vault-backed tokens via `setup matrix`. Your AI talks to you, not to a platform. |
| **Self-Modification** | Git snapshot + branch + test gate + approval. Tier 2 (vault passphrase) required. Memphis can improve itself — with your permission. |
| **Provider Cascade** | Ollama (local), MiniMax, DeepSeek, GLM, local-fallback. Automatic degradation. No single provider is a dependency. |
| **Worker / Async Runtime** | Local worker runner plus HTTP work-polling, signed worker session tokens, and scheduler/async chat dispatch without splitting runtime truth. |
| **ISKRA / MEMORY / PULSE** | Identity prompt, burn-after-action log, heartbeat monitor — the soul system. Memphis knows who it is, remembers what it did, and monitors its own health. |

---

## Architecture

```
Operator (you)
  |
  +-- CLI (memphis <cmd>)          -- 58+ commands, your control surface
  +-- Rust TUI (memphis tui)       -- Native terminal cockpit
  +-- HTTP API (:3000)             -- Fastify, token-authenticated
  +-- MCP Server                   -- JSON-RPC 2.0, tier-gated tools
  |
  +-- TypeScript Runtime (src/)
  |     +-- cognitive/model-{a-e}  -- 5 cognitive engines
  |     +-- gateway/               -- Telegram, channels, shared turn runtime
  |     +-- security/              -- Tier gates, fail-closed policy
  |     +-- soul/                  -- ISKRA identity, MEMORY log, PULSE heartbeat
  |     +-- work/                  -- local worker runner, polling, session tokens
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
  +-- Storage (yours, on your disk)
        +-- ~/.memphis/chains/     -- Append-only signed chains (source of truth)
        +-- data/memphis.db        -- SQLite indexes (derived, rebuildable)
        +-- data/vault-entries.json -- Encrypted secrets (AES-256-GCM)
```

**Nothing phones home.** No telemetry. No analytics. No cloud dependency. SQLite indexes are derived from chains and can be rebuilt. The chains are the source of truth.

---

## Authorization

Memphis enforces three tiers for all tool access. No exceptions.

| Tier | Auth Required | What You Can Do |
|------|--------------|-----------------|
| **0** | None | Journal, recall, health checks, case queries — read your own memory |
| **1** | API token | Vault secrets, config writes, provider changes — modify your runtime |
| **2** | Vault passphrase | Source modification, tool install, branch ops — change Memphis itself |

---

## CLI

```bash
# Health
memphis health --json            # Runtime health check
memphis doctor --json            # Deep diagnostic (chains, vault, providers)

# Memory
memphis journal "note"           # Write to journal chain
memphis recall "query"           # Semantic memory search
memphis search "exact phrase"    # FTS5 exact search
memphis reflect                  # Meta-cognitive reflection
memphis mode <A|B|C|D|E>        # Switch cognitive mode

# Vault (see docs/key-lifecycle.md for the full flow)
memphis secret set <key>         # Store encrypted secret
memphis secret get <key>         # Retrieve (requires passphrase)
memphis vault pepper-rotate --confirm     # Re-wrap master key under a new pepper
memphis vault master-key-rotate --confirm # Rotate master key + re-encrypt all entries
memphis vault entry-delete --key <k> --confirm  # Remove a single entry (refuses if .env refs it)
memphis vault recovery-unlock             # Reset operator passphrase via recovery Q/A
memphis audit search --action vault.      # Search audit log (current + gzip archives)

# Providers
memphis provider list            # Show configured providers
memphis provider add <name>      # Add provider (key goes to vault)

# Telegram
memphis telegram configure       # Set up bot token (stored in vault)
memphis telegram status          # Gateway readiness
memphis telegram send            # Send message to operator

# System
memphis tui                      # Native Rust console
memphis service install          # systemd user service
memphis backup                   # Backup chains and state
memphis evolve                   # Self-modification (tier 2)
```

---

## Configuration

Memphis uses `.env` for non-secret configuration. All secrets go through the vault.

```dotenv
DEFAULT_PROVIDER=ollama              # ollama | minimax | deepseek | glm | local-fallback
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=cogito:3b
RUST_CHAIN_ENABLED=true
MEMPHIS_AGENT_NAME=Memphis Agent
MEMPHIS_OWNER_NAME=local operator
```

```bash
memphis provider add minimax --api-key <your-key>   # Stores in vault, not .env
memphis telegram configure --bot-token <token>       # Stores in vault, not .env
```

See [.env.example](.env.example) for the full list.

---

## Development

```bash
npm run build              # Build Rust + TypeScript
npm run typecheck          # TypeScript --noEmit
npm run lint               # ESLint
npm run format:check       # Prettier
npm run test:ts            # Vitest (1299 tests)
npm run test:rust          # cargo test (204 tests)
npm run -s cli -- doctor   # Deep health check
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `memphis` not found | `npm link` from repo root, then `hash -r` |
| Rust build fails | `sudo apt install build-essential pkg-config libssl-dev` |
| Ollama not available | `curl http://127.0.0.1:11434/api/tags` — install Ollama if missing |
| Chain integrity error | `memphis doctor --json` — check `chains` section |
| Vault locked | Re-enter passphrase via `memphis init` or `memphis secret get <key>` |

See [Troubleshooting Guide](docs/TROUBLESHOOTING.md) for decision trees.

---

## Documentation

**Start here** → [Operator Handbook](docs/operator-handbook.md) — single-page entry point covering Day 0 install through Day 90 DR drill.

| Doc | Purpose |
|-----|---------|
| [Operator Handbook](docs/operator-handbook.md) | One-page operator workflow by time horizon |
| [SLO Baseline](docs/slo-baseline.md) | Latency / error budgets and breach policy |
| [Key Lifecycle](docs/key-lifecycle.md) | Pepper provisioning, vault init, provider keys, rotation |
| [Disaster Recovery](docs/disaster-recovery.md) | Backup / restore / cross-host vault recovery |
| [Chain Integrity](docs/chain-integrity.md) | `chain verify`, archive GC, snapshots |
| [Cognitive Modes](docs/cognitive-modes.md) | A/B/C/D/E dispatch, frame pipeline |
| [Config On The Fly](docs/config-on-the-fly.md) | Hot / warm / cold field taxonomy, reload paths |
| [Surface Parity](docs/surface-parity.md) | Capability matrix across TUI / Telegram / MCP / HTTP |
| [Observability](docs/observability.md) | Request-id, alert fan-out, Grafana dashboard |
| [Voice](docs/voice.md) | Telegram STT/TTS, `/voice on\|off`, daily TTS quota |
| [Cognitive Frames](docs/cognitive-frames.md) | Mode A frame buffer, post-turn capture, dispatch |
| [Self-Update](docs/self-update.md) | `memphis self-update check`, `/v1/ops/status.latestVersion` |
| [Self-Restart](docs/self-restart.md) | Tier-3 `/restart` across Telegram / TUI / HTTP / MCP / CLI |
| [Clean Install](docs/CLEAN-INSTALL.md) | Canonical install path from source |
| [Installation](docs/INSTALLATION.md) | Prerequisites, install, verify |
| [User Guide](docs/USER-GUIDE.md) | Complete operator manual |
| [Troubleshooting](docs/TROUBLESHOOTING.md) | Debug, fix, recover |
| [Architecture](docs/CANONICAL-ARCHITECTURE.md) | System boundaries and layers |
| [Project Status](docs/PROJECT-STATUS.md) | Current state and maturity |
| [Roadmap](docs/ROADMAP-CURRENT.md) | Current roadmap and milestones |
| [Upgrade Guide](docs/UPGRADE.md) | Migration between versions |
| [Release Process](docs/RELEASE-PROCESS.md) | CI/CD and release workflow |

---

## The Vision

Memphis is one layer of a larger architecture for digital sovereignty:

- **Memphis** — Sovereign AI runtime. Local-first cognitive agent with chain memory and encrypted vault.
- **Memphis Language (ML)** — A Lisp-like language for hardware control and inter-agent communication. The `ml-memphis` crate writes to Memphis chains. Integration path documented but deferred.
- **Matrix Federation** — Optional self-hosted Synapse for agent federation. Pilot config at `compose/matrix.yaml`. Not a core dependency.
- **Oswobodzeni** — The broader movement. Decentralized knowledge networks, censorship-resistant communication, self-sovereign identity. Memphis is the AI brain for this vision.

The goal is not to build another AI product. The goal is to build infrastructure for people who want to own their intelligence — their memory, their decisions, their identity — without asking permission from anyone.

---

## Release And CI Reference

### Release Candidate Path

Prepare release candidate (version bump, changelog, draft release):
```bash
./scripts/prepare-release-candidate.sh --version 1.2.2-rc.1
```

This creates a draft release via `.github/workflows/release-draft-dispatch.yml` without tagging or publishing.

Final GA release (tags, publishes package):
```bash
./scripts/release.sh --version 1.2.2
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

---

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0 — see [LICENSE](LICENSE)
