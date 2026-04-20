# Memphis Documentation

Index of all docs after the 2026-04-19 reorganization (PR #169 + sprint).

## Start here

- **Install:** [`operator/install.en.md`](./operator/install.en.md) · [`operator/install.pl.md`](./operator/install.pl.md)
- **First steps:** [`operator/example-installation/`](./operator/example-installation/)
- **Debug:** [`operator/debug.en.md`](./operator/debug.en.md) · [`operator/debug.pl.md`](./operator/debug.pl.md)
- **Current roadmap:** [`ROADMAP-CURRENT.md`](./ROADMAP-CURRENT.md)

## Status & Planning

Canonical status stack for "where is Memphis right now":

- **Project Status:** [`historical/PROJECT-STATUS.md`](./historical/PROJECT-STATUS.md) — maturity snapshot
- **Publish Status:** [`historical/PUBLISH-STATUS.md`](./historical/PUBLISH-STATUS.md) — latest released tag
- **Clean Install:** [`operator/CLEAN-INSTALL.md`](./operator/CLEAN-INSTALL.md) — canonical source-checkout path
- **Execution Plan:** [`historical/EXECUTION-PLAN.md`](./historical/EXECUTION-PLAN.md) — recent sprint plan

## By audience

### `operator/` — for users running Memphis

47 docs. Install, run, troubleshoot, vault, chains, providers, TUI, CLI, upgrades, deployment, runbooks. The bilingual install + debug guides above are the canonical entry points; the rest is reference.

### `dev/` — for developers contributing to Memphis

28 docs. Architecture (canonical, runtime, security, evolution), cognitive models, embedding pipeline, NAPI contract, vault internals, federation key exchange, testing, surface parity, performance tuning.

### `agents/` — for AI agents working on Memphis

Coordination protocol for Claude / Memphis-runtime / OpenClaw. Includes inter-agent handoff, tool registry conventions, and the OpenClaw integration spec.

### `historical/` — sprint logs, release process, planning

15 docs. Old execution plans, project status snapshots, release schedules, observability rollouts, alert policies. Useful for understanding how Memphis got here, not what to do next.

### `archive/` — older archived planning material

Two prior cleanup waves (PR #108 in 2026-04-14, PR #168 in 2026-04-19) plus older V5 / pre-V5 planning artifacts. Retained for audit; not authoritative for current behavior.

## By subject

### Architecture & internals

- `dev/CANONICAL-ARCHITECTURE.md`
- `dev/RUNTIME-SECURITY-ARCHITECTURE.md`
- `dev/RUNTIME-STATE-MODEL.md`
- `dev/EVOLUTION-ARCHITECTURE.md`
- `dev/COGNITIVE-ARCHITECTURE.md` + `dev/COGNITIVE-MODELS.md`
- `dev/EMBEDDING-ARCHITECTURE.md` + `dev/EMBED-PIPELINE.md`
- `dev/rust-crates-architecture.md`

### API contracts

- `api/` — REST endpoints
- `dev/API-REFERENCE.md` — top-level
- `dev/NAPI-CONTRACT-V1.md` — TS↔Rust bridge
- `dev/VAULT-API.md`
- `dev/MEMORY-FILE-FORMAT.md`

### Security

- `dev/SECURITY-GUIDE.md`
- `dev/key-lifecycle.md` + `dev/KEY-ROTATION-DESIGN.md` + `dev/VAULT-PEPPER-LIFECYCLE.md`
- `dev/GATEWAY-EXEC-HARDENING.md`
- `operator/tier3-runbook.md`

### Operations

- `runbooks/` — incident playbooks
- `operator/OPERATIONS-MANUAL.md`
- `operator/disaster-recovery.md`
- `operator/DB-BACKUP-BASELINE.md`
- `operator/DEPLOYMENT-CHECKLIST.md`
- `historical/RELEASE-PROCESS.md` + `historical/RELEASE-CHECKLIST.md`

### Federation & sync

- `dev/FEDERATION-KEY-EXCHANGE.md`
- `MEMPHIS-FEDERATION-DESIGN.md` (root) — design doc
- `agents/OPENCLAW-INTEGRATION.md`

### CLI / TUI

- `operator/CLI-REFERENCE.md`
- `operator/CLI-COMMAND-MATRIX.md`
- `operator/TUI-OPERATOR-GUIDE.md`
- `operator/voice.md`

### Vault

- `dev/VAULT-API.md` (internals)
- `operator/VAULT-CLI.md` (CLI surface)
- `dev/VAULT-PEPPER-LIFECYCLE.md`

### Chains

- `operator/chain-integrity.md`
- `operator/CHAIN-EXPORT.md` + `operator/CHAIN-IMPORT-JSON.md`

### Providers / LLMs

- `operator/OLLAMA-SETUP.md` + `operator/OLLAMA-BRIDGE-RUNBOOK.md`
- `operator/GUIDE-CUSTOM-LLM.md`

### Observability

- `observability/` — Grafana dashboards, OTel config
- `historical/observability.md` (rollout plan)
- `historical/slo-baseline.md`
- `historical/NIGHTLY-CRYSTAL.md`

### Cognitive

- `dev/COGNITIVE-MODELS.md` (5 models A-E)
- `dev/cognitive-modes.md`
- `dev/cognitive-frames.md`
- `dev/SOUL_GUIDE.md`

### Self-modification

- `dev/EVOLUTION-ARCHITECTURE.md` (architecture: how self-modify works)
- `operator/self-restart.md`
- `operator/self-update.md`

### Roadmap

- `ROADMAP-CURRENT.md` — current canonical roadmap (this file)
- `historical/EXECUTION-PLAN.md` — archived planning
- `PROPOSALS/` — WIP design proposals not yet promoted

## Conventions

- **Markdown.** Every doc is `.md` for grep-ability and rendering on GitHub.
- **Bilingual** for entry-point operator docs (install, debug). Internals + dev docs stay English-only.
- **Filenames** are lowercase-kebab-case for new docs; legacy ALL-CAPS preserved where moves would break external links.
- **Cross-links** use relative paths so the docs work browsed on GitHub or via `mkdocs serve` locally.

## How to add a doc

1. Pick the right bucket: operator (user-facing) / dev (architecture/code) / agents (Claude/Memphis-runtime/OpenClaw context) / historical (point-in-time records).
2. Use lowercase-kebab-case filename.
3. Open with one-sentence purpose + audience.
4. Cross-link to related docs at the bottom.
5. Add a date stamp at the bottom: `_Last verified: YYYY-MM-DD against vN.N.N._`
6. Update this index if your doc opens a new subject area.

---

_Last verified: 2026-04-19 against Memphis v1.3.0._
