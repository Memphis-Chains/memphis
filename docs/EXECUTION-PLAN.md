# Memphis Execution Plan

Status: canonical execution plan for turning the current repository into a coherent local-first agent product.

This plan is derived from the current codebase scan. It is intentionally focused on the critical path, not on optional integrations.

## 1. Goal

Deliver a repository where a new user can:

1. clone,
2. bootstrap,
3. initialize vault,
4. start Memphis,
5. open TUI or CLI,
6. converse with a named local agent,
7. rely on persistent memory,
8. trust that the agent understands its tools and runtime constraints.

## 2. Non-goals for this plan

Not in critical path:

- Synjar integration,
- OpenClaw packaging,
- HotelAI productization,
- broad multi-node federation hardening,
- cognitive feature expansion beyond what is needed for core UX.

Those may come later through downstream surfaces.

## 3. Workstreams

### P0-A. Fix the public memory contract

Problem:

- memory HTTP routes exist but are not registered in the main server path.

Target:

- `POST /api/journal` and `POST /api/recall` are real, authenticated, tested runtime endpoints.

Primary files:

- `src/infra/http/server.ts`
- `src/infra/http/routes/memory.ts`
- `src/infra/http/auth-policy.ts`
- `tests/unit/memory-routes.test.ts`
- add HTTP e2e coverage

Done definition:

- routes are registered,
- auth policy matches runtime behavior,
- docs match actual endpoint behavior,
- smoke request succeeds on live runtime.

### P0-B. Unify agent runtime across gateway, TUI, and CLI

Problem:

- gateway has a rich self-aware prompt and tool loop,
- TUI and CLI chat paths do not consistently use the same runtime model.

Target:

- the same system prompt model and tool awareness apply to gateway, TUI, and CLI chat modes.

Primary files:

- `src/gateway/system-prompt.ts`
- `src/gateway/chat-loop.ts`
- `src/infra/cli/commands/interaction.ts`
- `src/tui/index.ts`

Done definition:

- TUI chat knows tools and runtime constraints by default,
- CLI `chat` and `ask` can use the same agent runtime,
- operator does not need env-only prompt overrides to get the intended agent behavior.

### P0-C. Introduce a persistent agent profile

Problem:

- agent identity lives mostly in `.env`,
- product defaults are too personal and not appropriate as repository defaults.

Target:

- persistent local profile with neutral defaults,
- onboarding sets identity explicitly,
- runtime reads profile first, env second.

Primary files:

- `src/modules/workspace/context.ts`
- `src/infra/cli/onboarding-wizard.ts`
- `src/infra/config/schema.ts`
- new profile module under `src/infra` or `src/modules/workspace`

Done definition:

- agent name and owner are not hardcoded product assumptions,
- first-run flow writes profile locally,
- restarts preserve identity cleanly.

### P0-D. Clarify durable memory semantics

Problem:

- `memphis_journal` writes chain plus embedding index,
- `/embed store` writes embeddings directly without chain semantics.

Target:

- one explicit product model:
  - chain-backed memory is authoritative,
  - raw embed store is debug/operator surface, or
  - raw embed store becomes chain-aware.

Primary files:

- `src/mcp/tools/journal.ts`
- `src/mcp/tools/recall.ts`
- `src/tui/screens/embed-screen.ts`
- `src/infra/cli/handlers/embed.handler.ts`
- relevant docs

Done definition:

- users understand what counts as durable agent memory,
- recall behavior matches saved context model,
- no silent split between "real memory" and "debug memory".

### P1-A. Unify onboarding, help, and configuration messaging

Problem:

- guidance is improving but still spread across setup, onboarding, help, and runtime behavior.

Target:

- one coherent operator narrative from bootstrap through TUI usage.

Primary files:

- `src/infra/operator-guide.ts`
- `src/infra/cli/handlers/system.handler.ts`
- `src/infra/cli/handlers/storage.handler.ts`
- `src/tui/index.ts`
- `README.md`
- `docs/README.md`

Done definition:

- bootstrap, onboarding, CLI help, and TUI guide all tell the same story,
- secrets and persistence are explained consistently,
- startup path is singular and documented.

### P1-B. Make secret awareness explicit in all bootstrap paths

Problem:

- interactive onboarding surfaces credentials well,
- bootstrap and setup paths are less explicit.

Target:

- every setup path explains `MEMPHIS_API_TOKEN`, `MEMPHIS_VAULT_PEPPER`, vault passphrase, and persistence implications.

Primary files:

- `scripts/bootstrap.sh`
- `src/infra/cli/commands/setup.ts`
- `src/infra/cli/onboarding-wizard.ts`

Done definition:

- no silent secret generation without operator explanation,
- output clearly distinguishes regenerable values from irreversible dependencies.

### P1-C. Harden the channel/gateway story

Problem:

- HTTP runtime always starts,
- channel gateway is conditional and currently centered on Telegram.

Target:

- clear split between:
  - core local runtime,
  - optional channel gateway,
  - optional downstream integrations.

Primary files:

- `src/app/bootstrap.ts`
- `src/gateway/channels/*`
- docs

Done definition:

- operator understands what starts by default,
- no confusion between "Memphis runtime" and "Telegram bot mode".

### P2-A. Stabilize the NAPI contract

Problem:

- bridge works, but TS adapters still normalize historical drift.

Target:

- one normalized bridge contract for chain/embed/vault.

Primary files:

- `crates/memphis-napi/src/lib.rs`
- `src/infra/storage/rust-chain-adapter.ts`
- `src/infra/storage/rust-embed-adapter.ts`
- `src/infra/storage/rust-vault-adapter.ts`
- `docs/NAPI-CONTRACT-V1.md`

Done definition:

- one contract shape,
- clear compatibility rules,
- minimal legacy fallback burden.

### P2-B. Reduce documentation entropy

Problem:

- repo has many historical docs with conflicting paths and version assumptions.

Target:

- canonical docs win,
- historical docs are explicitly marked or deprecated.

Primary files:

- `docs/README.md`
- `docs/QUICKSTART.md`
- `docs/ARCHITECTURE-MAP.md`
- `docs/OPENCLAW-INTEGRATION.md`
- add deprecation notes where needed

Done definition:

- a new reader finds one start path and one architecture source of truth,
- obsolete path references are removed or quarantined.

### P2-C. Add end-to-end smoke path

Problem:

- many unit and ops tests exist,
- the core product path is not yet proven by one simple user-level acceptance flow.

Target:

- one canonical smoke flow:
  - bootstrap,
  - vault init,
  - dev,
  - TUI or CLI chat,
  - memory write,
  - recall,
  - tool visibility.

Primary files:

- `scripts/smoke-test.sh`
- `scripts/smoke-bootstrap-doctor.sh`
- new or updated smoke e2e tests

Done definition:

- the success path is mechanically verifiable,
- release readiness can depend on it.

## 4. Commit sequence

Recommended order:

1. `fix(http): register memory routes and cover authenticated memory API`
2. `feat(runtime): unify system prompt and tool-aware agent flow across gateway cli tui`
3. `feat(profile): persist agent identity outside env-only defaults`
4. `refactor(memory): clarify chain-backed memory vs raw embed operations`
5. `feat(onboarding): unify bootstrap secret awareness and operator guidance`
6. `refactor(bridge): stabilize napi contract and reduce legacy normalization`
7. `docs(canonical): collapse runtime and architecture docs to source-of-truth`
8. `test(smoke): add clone-to-chat acceptance flow`

## 5. Acceptance criteria

The plan succeeds when the repository supports this path:

```bash
git clone <repo>
cd memphis
npm run bootstrap
npm run -s cli -- vault init --passphrase '<pass>' --recovery-question '<q>' --recovery-answer '<a>'
npm run dev
npm run -s cli -- tui
```

And the operator gets:

- a local agent with explicit identity,
- a clear understanding of runtime, tools, memory, and vault,
- working authenticated HTTP and CLI/TUI memory flows,
- persistent recall across restarts,
- a consistent operator story across bootstrap, onboarding, CLI, and TUI.

## 6. Explicit stance on downstream integrations

Synjar, OpenClaw packs, and vertical products are not blocked by this plan.

They should be added after the core path is stable, through:

- managed apps,
- MCP tools,
- HTTP adapters,
- channel adapters,
- downstream repos.

They are extensions, not prerequisites for Memphis memory correctness.

## 7. Post-P2 productization roadmap

These streams assume P0-P2 are complete enough to shift focus from architecture closure to operator productization.

### Product constraints

- offline-first by default
- local-first runtime is the canonical path
- all integrations remain optional and configurable
- Memphis core stays neutral; domain logic belongs in downstream adapters and managed apps

### P3. Operator productization

Goal:

- make fresh install, runtime management, reset, and troubleshooting deterministic for a solo-local operator

Scope:

- add `memphis service install|status|logs|restart|uninstall`
- add `memphis reset --runtime --yes`
- remove false-positive `doctor` warnings on fresh install where the state is expected and healthy
- rewrite `README.md` as an operator-first entrypoint
- align `GETTING-STARTED`, `CONFIGURATION`, and `TROUBLESHOOTING` around the current bootstrap plus `systemd --user` path

Acceptance:

- a fresh machine can reach healthy runtime with one documented path
- runtime service lifecycle is manageable without repo archaeology
- `doctor` distinguishes missing setup from actual corruption clearly
- README is sufficient to reach a healthy local runtime

### P4. Optional integrations layer

Goal:

- define one clean downstream integration model without polluting core Memphis

Scope:

- document Synjar as an optional knowledge-layer adapter pattern
- provide managed app and MCP reference patterns for external services
- add one deployment reference for hotel/PMS-style environments
- keep all domain assumptions out of canonical core docs

Acceptance:

- core Memphis remains correct without Synjar, OpenClaw, or hotel-specific logic
- downstream integrations have one documented adapter path
- optional integrations can be enabled without redefining the product

### P5. Governance and recovery

Goal:

- harden Memphis for operators who need stronger recovery, retention, and audit workflows

Scope:

- formalize backup / restore / verify UX
- add clearer retention / redaction policy surfaces
- improve `doctor` modes for fresh-install vs production operation
- document shared-memory / multi-agent governance assumptions explicitly

Acceptance:

- operators can prove backup and restore behavior
- retention and redaction expectations are explicit
- shared-memory use is governed intentionally, not implied accidentally
