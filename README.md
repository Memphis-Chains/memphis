# Memphis

[![CI](https://github.com/Memphis-Chains/memphis/actions/workflows/ci.yml/badge.svg)](https://github.com/Memphis-Chains/memphis/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache%202.0-green.svg)](./LICENSE)

Memphis is a local-first agent runtime with chain-backed memory, a Rust security
core, and a TypeScript orchestration layer. It is designed for operators who
want an auditable agent that runs on their own machine and keeps durable memory
without turning GitHub or a hosted control plane into the source of truth.

## Current State

The latest published release is `v1.0.1`.

Current `main` is **post-`v1.0.1` documentation and status correction work**.
The core runtime is real and usable for source-first operators, but Memphis is
still in stabilization. The honest current position is:

Current `main` should be read as **operational but not stable**.

- local-first runtime works
- chain-first memory works
- release and CI paths work
- Rust TUI exists and is the active native console
- first-run is now controlled through `init`
- broader product stability and onboarding trust are still being tightened

Use these two docs as the current truth:

- [Project Status](docs/PROJECT-STATUS.md)
- [Current Roadmap](docs/ROADMAP-CURRENT.md)

Historical context for the first-run recovery remains in
[docs/FIRST-RUN-STOP-SHIP.md](docs/FIRST-RUN-STOP-SHIP.md). The active repair
queue remains in
[memory/ACTIVE-FIX-BACKLOG.md](memory/ACTIVE-FIX-BACKLOG.md).

## What Works Now

- Source-checkout bootstrap and controlled `init`
- Chain-backed journal, decisions, reflections, cases, and derived recall lanes
- CLI, HTTP, MCP, and Rust TUI on the same core runtime contract
- Vault-backed secrets and health/doctor/repair flows
- Release and CI gates for the current repository
- Optional bounded Matrix pilot setup through `setup matrix`

## What Is Still Not Stable

- First-run and onboarding still need more polish before they can be called
  effortless
- Rust TUI is the active console, but full onboarding remains CLI-first for now
- Legacy-state migration is improved, not perfect
- Public docs and release notes are now being cleaned up to match reality after
  a month of rapid architectural work

## Canonical Install Path

The supported full-runtime path is still **source checkout plus bootstrap**.
GitHub Releases and GitHub Packages publish the package artifact and a bounded
CLI distribution surface, but the primary operator path is:

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
npm run bootstrap
npm run -s cli -- init
npm run -s cli -- health --json
npm run -s cli -- tui
```

If `memphis` is already on your `PATH`, the same first-run flow is:

```bash
memphis init
memphis health --json
memphis tui
```

Bootstrap is technical install/build only. It does not silently create
meaningful identity or soul state. `init` is the controlled first-run step that
owns:

- operator passphrase enrollment
- vault initialization
- first-state mode selection
- preview/confirmation of initial chain writes
- final health summary

## Supported Surfaces

- **CLI**: canonical first-run, repair, health, and operator command surface
- **Rust TUI**: the current native single-view operator cockpit with live native chat streaming and seven logical native surfaces
- **HTTP API**: local authenticated runtime endpoints
- **MCP**: local tool/runtime integration path
- **Optional channels**: bounded Telegram/gateway path and optional Matrix pilot

The old TypeScript TUI remains archived under `legacy/tui-ts/` and is not an
active product surface.

## Memory And Runtime Truth

Memphis is now intentionally chain-first:

- local chains are the canonical memory source of truth
- SQLite exact search and other indexes are derived/rebuildable
- Git and GitHub are backup/review/CI surfaces, not runtime memory truth
- meaningful first-run state is created explicitly through `init`

Use `minimal-baseline` when you want the smallest transparent starting state, or
`guided-conversation` when you want first meaningful chains created through a
reviewable operator dialogue.

## Optional Matrix Pilot

Matrix remains optional and bounded. The pilot bootstrap path is:

```bash
npm run -s cli -- setup matrix --json
```

This path stores pilot bootstrap secrets in the local vault and only emits
`MEMPHIS_MATRIX_ACCESS_TOKEN=VAULT:MEMPHIS_MATRIX_ACCESS_TOKEN` when Memphis
actually acquires a real access token. It is not a core GA dependency.

## Documentation Map

- [Project Status](docs/PROJECT-STATUS.md): where Memphis actually stands now
- [Current Roadmap](docs/ROADMAP-CURRENT.md): how we got here and what comes next
- [Clean Install](docs/CLEAN-INSTALL.md): shortest fresh-install path from GitHub
- [Getting Started](docs/GETTING-STARTED.md): shortest operator path
- [Installation Guide](INSTALL.md): clean install and prerequisites
- [Documentation Index](docs/README.md): canonical docs map
- [Canonical Architecture](docs/CANONICAL-ARCHITECTURE.md): system boundaries
- [Runtime State Model](docs/RUNTIME-STATE-MODEL.md): storage and state truth
- [Release Process](docs/RELEASE-PROCESS.md): release workflow
- [Publish Status](docs/PUBLISH-STATUS.md): package/release publication truth

## Architecture

Memphis combines:

- a **Rust core** for chain integrity, vault encryption, embeddings, and the
  native operator seam
- a **TypeScript runtime** for orchestration, CLI, HTTP, MCP, and provider
  behavior

Core crates:

- `memphis-core`
- `memphis-vault`
- `memphis-embed`
- `memphis-operator`
- `memphis-tui`
- `memphis-napi`

Core TypeScript domains:

- `src/app/`
- `src/infra/cli/`
- `src/infra/http/`
- `src/infra/storage/`
- `src/cognitive/`
- `src/soul/`

## Development

```bash
npm run build
npm run typecheck
npm run lint
npm run test:ts
npm run test:rust
npm run -s cli -- doctor
```

## HTTP API Quick Test

```bash
TOKEN=$(grep '^MEMPHIS_API_TOKEN=' .env | cut -d= -f2-)

curl http://127.0.0.1:3000/health

curl -X POST http://127.0.0.1:3000/api/journal \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"content":"test memory","tags":["test"]}'

curl -X POST http://127.0.0.1:3000/api/recall \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query":"test memory","limit":5}'
```

## Release And CI Reference

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
```

- failure-path contract debug command:

```bash
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

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Memphis is licensed under the [Apache License 2.0](LICENSE).

`package.json` declares `Apache-2.0`, the repository ships the Apache 2.0 text
in `LICENSE`, and the current docs treat Apache-2.0 as the canonical public
license for the project.
