# Memphis

Memphis – Self‑Evolving AI Agent Runtime
Memphis is a secure, local‑first agent operating system that combines a Rust core for cryptographic integrity and high‑performance memory, with a TypeScript runtime for orchestration, CLI, TUI, and policy enforcement. It’s designed for operators who want a sovereign AI assistant that can remember, reason, and safely rewrite itself.

✨ Key Features
Persistent Soul – the agent knows its identity, capabilities, and user preferences across sessions. Soul memory is stored in structured JSON and injected into the system prompt.

Structured Memory with Polish Grammatical Cases – every action is recorded as one of eight semantic cases (Nominative, Genitive, Dative, Accusative, Instrumental, Locative, Ablative, Vocative), enabling the agent to reason about its own past with queries like “What tools did I use to modify providers?” → Instrumental query.

High‑Performance Rust Core – chain integrity (hash‑linked), encrypted vault, HNSW embeddings, and a rebuildable SQLite index for fast case‑based queries.

Tiered Authorization (Coming Soon) – three‑level permission model with adaptive autonomy modes (quiet, balanced, paranoid) and operator‑defined trust rules.

Safe Self‑Modification (Coming Soon) – the agent can modify its own source code in isolated git branches, with snapshots, test gates, and crash‑recovery rollback.

Operator‑First – all data stays on your machine, encrypted at rest. No cloud dependencies. Full control via CLI, TUI, HTTP API, and MCP server.

Provider‑Agnostic – supports local models (Ollama, llama.cpp) and remote APIs (OpenAI, Anthropic, DeepSeek, Minimax). Add new providers via a simple registry.

🚀 Quick Start (Source‑First)
bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
npm run bootstrap
npm run -s cli -- vault init --passphrase "<your-pass>" \
  --recovery-question "<question>" --recovery-answer "<answer>"
npm run dev               # start the service
npm run -s cli -- tui     # open the terminal UI
For more details, see INSTALL.md and the documentation.

🧠 Why Memphis?
Most AI agents are stateless, forgetful, and cannot improve themselves. Memphis is built from the ground up to be:

Self‑aware – it remembers what it knows, what you like, and how it has evolved.

Self‑improving – it can rewrite its own tools, add providers, and fix bugs, with your oversight.

Secure – secrets live in an encrypted vault, all mutations are audited in an append‑only chain.

Local‑first – you own your data. The agent runs on your hardware, under your control.

📦 What’s Inside
crates/ – Rust core: memphis-chain (hash‑linked blocks), memphis-vault (encrypted secrets), memphis-embed (HNSW vectors), memphis-case-index (SQLite case cache).

src/ – TypeScript runtime: gateway, MCP tools, CLI, TUI, provider registry, soul system.

docs/ – architecture docs, runbooks, and integration guides.

tests/ – unit, integration, chaos, and regression tests.

🔮 Roadmap (Next Phases)
Phase B – Tiered Authorization – granular permissions, adaptive autonomy, trust rules.

Phase C – Safe Self‑Modification – agent‑driven code changes with snapshot rollback.

Phase D – Unified Onboarding – single memphis init wizard, secret management, Telegram integration.

Phase E – Webhooks & Federation – react to external events, collaborate with other agents.

Phase F – Self‑Healing – automatic pruning, watchdog, and resource management.

Phase G – UX Polish – TUI enhancements, natural‑language case queries, explainability.

Phase H – Integration & Release – end‑to‑end tests, performance benchmarks, final packaging.

See ROADMAP.md for the full plan.

🤝 Contributing
We welcome contributions! Check out CONTRIBUTING.md for guidelines. Areas where help is especially appreciated:

Adding new LLM providers (DeepSeek, Minimax, etc.)

Improving the case‑based reasoning tools

Enhancing the TUI

Writing tests and documentation

📄 License
Memphis is open‑source under the MIT License.

💬 Community & Support
GitHub Issues – bug reports and feature requests

Discord – chat with the team and other users

Documentation – full reference and guides

Memphis – an agent that grows with you.

## 5-Minute Quick Start

Requirements:
- Linux or macOS with `bash`
- Node.js 24.x recommended, Node.js `>=20` supported
- Rust stable toolchain (`cargo`, `rustc`)
- `git`
- Ollama recommended for a local provider

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
npm run bootstrap
npm run -s cli -- vault init \
  --passphrase "your-secret" \
  --recovery-question "your question" \
  --recovery-answer "your answer"
npm run -s cli -- doctor --fix
npm run -s cli -- health --json
```

If bootstrap could not enable the user service, run the HTTP server manually:

```bash
npm run dev
```

Then, in another terminal:

```bash
npm run -s cli -- tui
```

## What `npm run bootstrap` Does

Bootstrap currently:
- creates `.env` from `.env.example` when needed
- generates `MEMPHIS_API_TOKEN` and `MEMPHIS_VAULT_PEPPER` when missing
- ensures `MEMPHIS_AGENT_NAME`, `MEMPHIS_OWNER_NAME`, and a persistent agent profile exist
- enables `RUST_CHAIN_ENABLED=true`
- enables embedding persistence with `RUST_EMBED_PERSIST_ENABLED=true`
- installs dependencies and builds Rust + TypeScript
- initializes the repo root as a Memphis workspace (`.memphis/context.json`, `AGENTS.md`, `CLAUDE.md`)
- installs and enables `memphis.service` via `systemd --user` when available

## Start and Manage the Service

If bootstrap installed the service, use:

```bash
npm run -s cli -- service status
npm run -s cli -- service restart
npm run -s cli -- service logs --latest 100
```

Low-level `systemd --user` equivalents:

```bash
systemctl --user status memphis.service
systemctl --user restart memphis.service
journalctl --user -u memphis -f
```

If your host does not provide `systemd --user`, run Memphis manually:

```bash
npm run dev
```

## First Health Checks

```bash
npm run -s cli -- guide
npm run -s cli -- doctor --fix
npm run -s cli -- health --json
curl http://127.0.0.1:3000/health
```

Expected result:
- `doctor` reports zero failures
- `/health` returns `healthy`
- `guide` explains identity, tools, memory, vault, and next commands

## First Durable Memory Test

### CLI

```bash
npm run -s cli -- embed store --id smoke --value "runtime is healthy"
npm run -s cli -- embed search --query healthy --limit 5
```

`embed store` is chain-backed. Memphis first writes auditable memory and then indexes it for recall.

### HTTP

```bash
TOKEN=$(grep '^MEMPHIS_API_TOKEN=' .env | cut -d= -f2-)

curl -X POST http://127.0.0.1:3000/api/journal \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"content":"Guest prefers quiet room","tags":["guest","preference"]}'

curl -X POST http://127.0.0.1:3000/api/recall \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query":"quiet room","limit":5}'
```

## Installation Notes

For the full local runtime, use the source-first path above.

For release distribution:
- GitHub Releases attach one npm tarball asset
- GitHub Packages publishes `@memphis-chains/memphis`
- the CLI entrypoint remains `memphis`

The package/release flow is documented in `docs/PACKAGE-PUBLISH.md` and `docs/RELEASE-PROCESS.md`.

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

## Troubleshooting

### Server does not respond on `:3000`

Check whether the service is running:

```bash
npm run -s cli -- service status
npm run -s cli -- service logs --latest 100
```

If there is no user service, run manually:

```bash
npm run dev
```

### `chain integrity check failed` during startup

This means a local chain file does not match the expected hash chain. Run:

```bash
npm run -s cli -- doctor --json
```

If this came from a stale local test state, reset the local runtime state and bootstrap again. See `docs/TROUBLESHOOTING.md` before deleting local data.

```bash
npm run -s cli -- reset --runtime --yes
npm run bootstrap
```

### `better-sqlite3` or `NODE_MODULE_VERSION` mismatch

This usually means the runtime is starting with a different Node binary than the one used to install dependencies. Re-run:

```bash
npm ci
npm run build
npm run bootstrap
```

If you use `nvm`, confirm the same Node version is used by your shell and the user service.

### Vault commands fail

Check that:
- `MEMPHIS_VAULT_PEPPER` exists in `.env`
- you have run `vault init`
- you did not rotate the pepper after creating vault data

### `doctor` warns about daemon status or stale files

Run:

```bash
npm run -s cli -- doctor --fix
```

If warnings persist after a fresh install, inspect `~/.memphis` and:

```bash
npm run -s cli -- service logs --latest 100
```

## Optional Integrations

Memphis core stays neutral. Integrations are optional and downstream.

Current optional paths include:
- OpenClaw channel integration: `docs/OPENCLAW-INTEGRATION.md`
- managed apps and MCP tools: see CLI `apps` and `mcp` commands
- hotel/Synjar/PMS deployment patterns: `docs/HOTEL-DEPLOYMENT-REFERENCE.md`

## Docs Map

Start here:
- [Getting Started](docs/GETTING-STARTED.md)
- [Configuration](docs/CONFIGURATION.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [API Reference](docs/API-REFERENCE.md)

Canonical product docs:
- [Canonical Architecture](docs/CANONICAL-ARCHITECTURE.md)
- [Execution Plan](docs/EXECUTION-PLAN.md)
- [NAPI Contract](docs/NAPI-CONTRACT-V1.md)

Operational and downstream docs:
- [Package Publish](docs/PACKAGE-PUBLISH.md)
- [Release Process](docs/RELEASE-PROCESS.md)
- [OpenClaw Integration](docs/OPENCLAW-INTEGRATION.md)
- [Hotel Deployment Reference](docs/HOTEL-DEPLOYMENT-REFERENCE.md)
