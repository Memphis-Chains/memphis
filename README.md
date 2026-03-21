# Memphis

Memphis is a secure local-first agent runtime and control plane.

It combines:
- Rust core crates for chain integrity, vault, deterministic replay primitives, and embeddings
- a TypeScript runtime for CLI, TUI, HTTP, orchestration, and policy enforcement
- chain-backed durable memory with semantic recall
- operator-first local control, including guided bootstrap, health checks, and systemd autostart on supported Linux hosts

## What Memphis Is

Memphis is for:
- running a local or self-hosted agent runtime
- supervising tools, memory, vault state, and runtime health
- preserving auditable local state through chain-backed memory and incident/export surfaces
- exposing operator control through CLI, TUI, HTTP, and MCP

## What Memphis Is Not

Memphis is not:
- a desktop operating system
- a hosted SaaS product
- a document-RAG platform by default
- a hardcoded Telegram bot product

Read "agent operating system" here as runtime, memory, policy, and operator control for AI agents.

## Supported Paths

Memphis currently supports two different paths:

- Source-first runtime: canonical for the full Rust-backed solo-local runtime
- Package-first release: canonical for release distribution (`@memphis-chains/memphis` and GitHub Release tarball)

Today, the full operator path is still source-first. Package releases are the distribution channel, but the documented complete local runtime remains: clone -> bootstrap -> vault init -> run.

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
