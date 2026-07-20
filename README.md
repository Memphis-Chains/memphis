# Memphis

[![CI](https://github.com/Memphis-Chains/memphis/actions/workflows/ci.yml/badge.svg)](https://github.com/Memphis-Chains/memphis/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache%202.0-green.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933)](https://nodejs.org)
[![Rust](https://img.shields.io/badge/rust-stable-orange)](https://www.rust-lang.org)
[![Website](https://img.shields.io/badge/website-memphis--v5.pl-ff6b35)](https://memphis-v5.pl)

**Sovereign AI that runs on your machine, remembers in chains you own, and answers to no one but you.**

Memphis is a local-first cognitive runtime born from [Oswobodzeni](https://oswobodzeni.pl) — a movement for digital sovereignty where citizens, not corporations, control their data, identity, and tools. In a world where AI lives in someone else's cloud, Memphis is the opposite: an agent runtime you install on your own hardware, with memory sealed in append-only cryptographic chains, secrets locked in a vault only you can open, and zero telemetry going anywhere.

Every decision Memphis makes is recorded. Every secret is encrypted at rest. Every tool it touches requires your authorization. This is not a chatbot — it is a sovereign cognitive system designed for operators who refuse to rent their intelligence from Big Tech.

**Current version: `v1.10.0`** (matches `package.json`) | **Status: production-ready for operator-supervised runtime** — Kartograf ONNX runtime + `memphis_kartograf` tool + `kartograf-zone-router` built-in skill, Telegram document/PDF ingestion (pdftotext + raw text + image-as-doc), full MiniMax model lineup (12 chat models, accurate context windows), first-class skill composition (`memphis_skill_*`), provider auto-failover on stream timeout, tier-3 session persistence across daemon restart, degraded boot + vault-recovery runbook. See [`CHANGELOG.md`](./CHANGELOG.md) for full history.

**Public surface:** [memphis-v5.pl](https://memphis-v5.pl) · [start](https://memphis-v5.pl/start/) · [docs](https://memphis-v5.pl/docs/) · [roadmap](https://memphis-v5.pl/roadmap/) · [llms.txt](https://memphis-v5.pl/llms.txt) · [agents.json](https://memphis-v5.pl/agents.json)

---

## First time? Read [`ONBOARDING.md`](./ONBOARDING.md)

The canonical 5-minute pointer: install paths, daily-use runbook, operator docs map. Skip to "Install in 8 minutes" below if you already know what you want.

## Install in 8 minutes

Linux, macOS, or WSL2. Installs Node 22, Rust stable, Ollama, clones the repo, builds everything, and links the `memphis` CLI globally:

```bash
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash
```

Add `--with-init` to chain first-run (vault passphrase, identity, provider enrollment) into the same session — ends with a running operator instead of a linked CLI:

```bash
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash -s -- --with-init
```

Then (or if you left `--with-init` off) walk the canonical first-run:

```bash
memphis init                    # passphrase, vault, identity, first chain writes
memphis provider add anthropic  # (optional) cloud provider — repeat for minimax/deepseek/glm
memphis service install && memphis service restart  # Linux / WSL systemd-user only; see macOS note below
memphis tui                     # open the native operator cockpit
```

> **macOS operators**: `memphis service install` wires a systemd-user unit, so the step above is a no-op on macOS. Either run the runtime in a terminal with `npm run dev` while you need it, or provision a `launchd` plist at `~/Library/LaunchAgents/chains.memphis.runtime.plist` that `exec`s the same command. The remaining steps (`memphis init`, `memphis provider add …`, `memphis tui`) work identically across Linux, macOS, and WSL.

> **If `memphis: command not found`** after install: the post-install `npm link` step is path-scoped. Run `hash -r` to refresh the shell hash, or `which memphis` to confirm the binary location, then either add that directory to `PATH` or re-run `npm link` from the repo root.

That's it. Sovereign AI running on your machine, with encrypted vault, chain-backed memory, 200k-token Claude access (if you added anthropic), and local Ollama fallback when the network's down.

**What you get in 5 minutes** (past the Rust build, which dominates the 8-minute clock):

- **Encrypted vault** — Argon2id + AES-256-GCM, separate operator and vault passphrases, 2FA Q&A recovery
- **Provider cascade** — `anthropic → ollama → local-fallback` by default; add `minimax`, `deepseek`, or `glm` via `memphis provider add`. One drops, next takes over automatically
- **Chain-backed memory** — journal / decisions / reflections / 8 semantic case roles, every block SHA-256 linked (Ed25519 signing activates when `RUST_CHAIN_REQUIRE_SIGNATURES=true`)
- **Native TUI cockpit** (Rust) — chat, memory browser, session history, vault, cases, system health, all in one terminal
- **Telegram-ready** — [`memphis setup telegram`](./docs/operator/CLI-REFERENCE.md) or `.env` config for remote bot access
- **MCP-ready** — stdio + HTTP transport for Claude Code / ChatGPT / Cursor integration
- **HTTP API** — Fastify on `:3000`, bearer-token protected, `/v1/chat/*`, `/v1/ops/status`, `/v1/vault/*`, SSE session events
- **Kartograf ONNX runtime** — `memphis kartograf …` for embedding + zone routing; ~700 MB checkpoint, lazy-loaded
- **Skills composition** — `memphis skills …` for scaffold / validate / install skills without round-tripping through generic file-write tools

**New to Memphis?** Step-by-step walkthrough — [English](./docs/operator/install-fresh-user.en.md) or [Polish](./docs/operator/install-fresh-user.pl.md) (12 steps with verification after each) assumes zero prior knowledge and explains what each command does and why.

**Experienced operator?** Jump straight to [`docs/operator/install.en.md`](./docs/operator/install.en.md) or [`docs/operator/install.pl.md`](./docs/operator/install.pl.md) for the compact reference.

---

## Why Memphis Exists

Technology can be chains or keys. The centralized AI model — where your conversations, your data, your business logic live on someone else's servers, governed by someone else's policies — is a sovereignty problem. Memphis solves it:

- **Your machine, your memory.** Nothing leaves your hardware unless you explicitly send it.
- **Chain-backed truth.** Every journal entry, decision, reflection, and system event is written to append-only SHA-256 linked chains. No silent edits. No disappearing history. Ed25519 block signing is available behind an opt-in flag (`RUST_CHAIN_REQUIRE_SIGNATURES=true`) for environments that need cryptographic non-repudiation; the default is SHA-256 linkage only.
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

| What you want                             | Command                                |
| ----------------------------------------- | -------------------------------------- |
| First-run (passphrase + vault + identity) | `memphis init`                         |
| Health check                              | `memphis health`                       |
| Diagnose + auto-repair                    | `memphis doctor --fix`                 |
| Start / stop / restart daemon             | `memphis service {start,stop,restart}` |
| Daemon status                             | `memphis service status`               |
| Recent daemon logs                        | `memphis service logs -n 100`          |
| Open native TUI console                   | `memphis tui`                          |
| List configured providers                 | `memphis providers list`               |
| Inspect vault                             | `memphis vault list`                   |
| Add a vault secret                        | `memphis vault add <key>`              |
| Memory write                              | happens automatically during `memphis tui` / `memphis ask` (agent calls `memphis_journal` tool) |
| Hybrid search (semantic + FTS5)           | `memphis search --query "<phrase>"`    |
| Agent self-modification log               | `memphis evolve log`                   |

Run `memphis --help` for the full surface.

### Manual install

Prefer a source-checkout + bootstrap workflow? See [INSTALL.md](./INSTALL.md) for step-by-step manual instructions, or [docs/operator/CLEAN-INSTALL.md](./docs/operator/CLEAN-INSTALL.md) for the canonical source checkout path used by contributors (`git clone` + `npm run bootstrap`).

You can also audit the installer without running it:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh) --check-only --json
```

---

## What Memphis Does

| Capability                 | What It Means                                                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Chain Memory**           | 7 append-only, SHA-256 linked chains (journal, decisions, reflections, cases, patterns, collective, system). Ed25519 signing activates when `RUST_CHAIN_REQUIRE_SIGNATURES=true`. Session memory and conversation compaction now sit on top as derived overlays, not separate memory truths. |
| **Encrypted Vault**        | AES-256-GCM + Argon2id. All API keys, tokens, and passphrases live here. Not in `.env`. Not in plaintext. In the vault.                                                                                                  |
| **5 Cognitive Modes**      | A (Capture), B (Inference), C (Prediction), D (Collective), E (Meta-Reflection). Toggle per session. Each writes to its own chain.                                                                                       |
| **Rust TUI**               | Native operator cockpit with live chat streaming, transcript scrollback, wrapped output, busy animation, token/context telemetry, and pressure visibility across Overview, Chat, Memory, Sessions, Vault, Cases, System. |
| **MCP Server**             | Shared runtime tool lane with factory-backed tool registry, bounded concurrency for safe tools, and tier-based authorization (Tier 0/1/2).                                                                               |
| **Telegram Gateway**       | Bidirectional: operator commands in, system events out. Vault-backed tokens via `setup matrix`. Your AI talks to you, not to a platform.                                                                                 |
| **Self-Modification**      | Git snapshot + branch + test gate + approval. Tier 2 (vault passphrase) required. Memphis can improve itself — with your permission.                                                                                     |
| **Provider Cascade**       | Ollama (local), MiniMax, DeepSeek, GLM, local-fallback. Automatic degradation. No single provider is a dependency.                                                                                                       |
| **Worker / Async Runtime** | Local worker runner plus HTTP work-polling, signed worker session tokens, and scheduler/async chat dispatch without splitting runtime truth.                                                                             |
| **ISKRA / MEMORY / PULSE** | Identity prompt, burn-after-action log, heartbeat monitor — the soul system. Memphis knows who it is, remembers what it did, and monitors its own health.                                                                |

---

## Architecture

```
Operator (you)
  |
  +-- CLI (memphis <cmd>)          -- 88 top-level commands, your control surface
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
  |     +-- memphis-core           -- Chain integrity, SHA-256 linking, optional Ed25519 (RUST_CHAIN_REQUIRE_SIGNATURES=true)
  |     +-- memphis-vault          -- AES-GCM encryption, Argon2 KDF
  |     +-- memphis-embed          -- Embeddings pipeline
  |     +-- memphis-export         -- Chain export + migration utilities
  |     +-- memphis-paths          -- Cross-platform path resolution
  |     +-- memphis-tui            -- Native operator console
  |     +-- memphis-napi           -- Node.js bridge (N-API)
  |     +-- memphis-operator       -- Native chat runtime
  |     +-- memphis-case-index     -- Case chain indexing
  |
  +-- Storage (yours, on your disk)
        +-- ~/.memphis/chains/     -- Append-only SHA-256 linked chains, source of truth (Ed25519 optional via RUST_CHAIN_REQUIRE_SIGNATURES)
        +-- data/memphis.db        -- SQLite indexes (derived, rebuildable)
        +-- data/vault-entries.json -- Encrypted secrets (AES-256-GCM)
```

**Nothing phones home.** No telemetry. No analytics. No cloud dependency. SQLite indexes are derived from chains and can be rebuilt. The chains are the source of truth.

---

## Authorization

Memphis enforces three tiers for all tool access. No exceptions.

| Tier  | Auth Required    | What You Can Do                                                       |
| ----- | ---------------- | --------------------------------------------------------------------- |
| **0** | None             | Journal, recall, health checks, case queries — read your own memory   |
| **1** | API token        | Vault secrets, config writes, provider changes — modify your runtime  |
| **2** | Vault passphrase | Source modification, tool install, branch ops — change Memphis itself |

---

## CLI

```bash
# Health
memphis health --json            # Runtime health check
memphis doctor --json            # Deep diagnostic (chains, vault, providers)

# Memory
memphis search --query "<phrase>" # Hybrid semantic + FTS5 retrieval
memphis chain verify              # Chain integrity check
memphis reflect                   # Meta-cognitive reflection
memphis mode <A|B|C|D|E>          # Switch cognitive mode
# Journal writes happen automatically during `memphis tui`/`memphis ask`
# (agent calls the `memphis_journal` tool — not a top-level CLI verb)

# Vault (see docs/dev/key-lifecycle.md for the full flow)
memphis secret add --key <key> --value <plaintext>  # Store encrypted secret (gated by passphrase)
memphis secret get --key <key>                       # Retrieve & decrypt (gated by passphrase)
memphis secret list                                  # List stored secret keys + metadata
memphis vault pepper-rotate --confirm                # Re-wrap master key under a new pepper
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

| Problem               | Fix                                                                  |
| --------------------- | -------------------------------------------------------------------- |
| `memphis` not found   | `npm link` from repo root, then `hash -r`                            |
| Rust build fails      | `sudo apt install build-essential pkg-config libssl-dev`             |
| Ollama not available  | `curl http://127.0.0.1:11434/api/tags` — install Ollama if missing   |
| Chain integrity error | `memphis doctor --json` — check `chains` section                     |
| Vault locked          | Re-enter passphrase via `memphis init` or `memphis secret get <key>` |

See [Troubleshooting Guide](docs/operator/TROUBLESHOOTING.md) for decision trees.

---

## Documentation

**Start here** → [Operator Handbook](docs/operator/operator-handbook.md) — single-page entry point covering Day 0 install through Day 90 DR drill.

| Doc                                            | Purpose                                                     |
| ---------------------------------------------- | ----------------------------------------------------------- |
| [Operator Handbook](docs/operator/operator-handbook.md) | One-page operator workflow by time horizon         |
| [SLO Baseline](docs/historical/slo-baseline.md)         | Latency / error budgets and breach policy          |
| [Key Lifecycle](docs/dev/key-lifecycle.md)              | Pepper provisioning, vault init, provider keys, rotation |
| [Disaster Recovery](docs/operator/disaster-recovery.md) | Backup / restore / cross-host vault recovery       |
| [Chain Integrity](docs/operator/chain-integrity.md)     | `chain verify`, archive GC, snapshots              |
| [Cognitive Modes](docs/dev/cognitive-modes.md)          | A/B/C/D/E dispatch, frame pipeline                 |
| [Config On The Fly](docs/operator/config-on-the-fly.md) | Hot / warm / cold field taxonomy, reload paths     |
| [Surface Parity](docs/dev/surface-parity.md)            | Capability matrix across TUI / Telegram / MCP / HTTP |
| [Observability](docs/historical/observability.md)       | Request-id, alert fan-out, Grafana dashboard       |
| [Voice](docs/operator/voice.md)                         | Telegram STT/TTS, `/voice on\|off`, daily TTS quota |
| [Cognitive Frames](docs/dev/cognitive-frames.md)        | Mode A frame buffer, post-turn capture, dispatch            |
| [Self-Update](docs/operator/self-update.md)             | `memphis self-update check`, `/v1/ops/status.latestVersion` |
| [Self-Restart](docs/operator/self-restart.md)           | Tier-3 `/restart` across Telegram / TUI / HTTP / MCP / CLI  |
| [Force Flags](docs/operator/FORCE-FLAGS.md)             | `MEMPHIS_VAULT_FORCE_REINIT` + `MEMPHIS_RESTART_ALLOW_SUICIDE` bypass contracts |
| [Clean Install](docs/operator/CLEAN-INSTALL.md)         | Canonical install path from source                          |
| [Installation](docs/operator/INSTALLATION.md)           | Prerequisites, install, verify                              |
| [User Guide](docs/operator/USER-GUIDE.md)               | Complete operator manual                                    |
| [Troubleshooting](docs/operator/TROUBLESHOOTING.md)     | Debug, fix, recover                                         |
| [Architecture](docs/dev/CANONICAL-ARCHITECTURE.md)      | System boundaries and layers                                |
| [Rust Distribution](docs/dev/RUST-DISTRIBUTION.md)      | NAPI bridge: per-platform sub-packages + S9 migration plan  |
| [Project Status](docs/historical/PROJECT-STATUS.md)     | Current state and maturity                                  |
| [Roadmap](docs/ROADMAP-CURRENT.md)                      | Current roadmap and milestones                              |
| [Upgrade Guide](docs/operator/UPGRADE.md)               | Migration between versions                                  |
| [Release Process](docs/dev/RELEASE-PROCESS.md)          | GPG signing, secrets, key rotation, release smoke           |

Project state: the 14-sprint V5→V14 roadmap is fully shipped. Historical planning docs are preserved under [`docs/archive/2026-04-14-post-roadmap-cleanup/`](docs/archive/2026-04-14-post-roadmap-cleanup/).

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
