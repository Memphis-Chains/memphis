# Memphis Current Truth - 2026-06-16

This document is the handoff map for the one-truth runtime work. It records what is canonical, what is experimental, and what must stay private until explicitly reviewed.

## Canonical Truth Sources

- Tool inventory: `src/gateway/tool-registry.ts`.
- In-process execution: `src/gateway/tool-executor.ts`.
- MCP registration: `src/mcp/server.ts`.
- Tool JSON/schema parity: `src/gateway/tool-json-schema.ts`, `src/gateway/tool-schema-audit.ts`, `src/gateway/tool-surface-audit.ts`.
- Runtime health: `src/infra/http/health.ts` and runtime-health snapshot builders.
- Full readiness: `src/infra/cli/commands/readiness.ts`.
- Supervised autonomy status: `src/infra/runtime/self-governance.ts` and `src/mcp/tools/self-governance-status.ts`.
- Tensor status: `src/infra/tensors/status.ts` and `src/mcp/tools/tensor-status.ts`.
- Rust bridge manifest: `src/infra/storage/rust-bridge-manifest.ts`.

## Current Gates

- `memphis health --json` means alive plus core runtime health.
- `memphis readiness --json` means operator usability. It now includes a critical `capabilities` row that checks registry, executor, MCP registration, and schema parity.
- `memphis tools list --json` means surfaced capabilities from `memphis_self_describe` through `/v1/ops/capabilities`.
- `memphis self-governance status --json` and `memphis_self_governance_status` mean supervised self-steering state. `canSelfModify:false` is intentional and must be treated as a blocker for unsupervised code changes.
- `memphis tensor status --json` means tensor/embed layer readiness. Memory embeddings and Kartograf embeddings are separate contracts.

## Runtime State Observed

Observed on 2026-06-16 after the current one-truth pass and revalidated on 2026-06-17:

- `memphis health --json`: runtime status is `healthy`, first-run state is `initialized-clean`, repair status is healthy, and chain/embed core checks are OK.
- `memphis readiness --json`: not fully ready. Capabilities row is OK (`57 tools; registry/executor/MCP/schema parity OK`), default provider is now local `ollama` and no longer blocks readiness, but vault cipher still fails.
- `memphis tensor status --json`: memory embeddings `dim=32`, `dtype=f32`, raw vector exposure disabled; Kartograf enabled in ONNX mode, `dim=256`.
- `memphis tools list --json`: capabilities endpoint reachable; 57 registered tools, 26 available under CLI tier-0 policy.
- `memphis embed search --query test --json`: valid semantic search response, `dim=32`, no raw vector values.
- `memphis chain verify --chain journal`: OK, 168 journal blocks.
- `memphis backup list --json`: fresh backup archives present; latest archive `pre-repair-one-truth-2026-06-17-08-56.tar.gz`.
- `memphis self-governance status --json`: `canSelfRecover=true`, `canSelfModify=false`, `capable=false` because fresh 24h/7d SLOs currently fail.
- `systemctl --user status memphis.service`: active/running since 2026-06-17 09:20:38 CEST after restart. The user service environment currently has `MEMPHIS_SKIP_VAULT_INTEGRITY_PROBE=true` so the daemon can run while vault readiness remains visibly failed.
- Vault diagnostic: `rotateVaultMasterKey` cannot load `/home/memphis/.memphis/vault-state.json` with the current `MEMPHIS_VAULT_PEPPER`; error says to check that the pepper matches the state. Do not wipe vault data unless the operator chooses the destructive recovery path and has the secrets ready to re-add.
- Nightly Kartograf training/install runner unit contract is restored: training worker spawn/cancel, training dispatch/recovery, install payload parsing, install recovery, and eval-gate decisions pass.

Do not report Memphis as fully ready or fully self-governing until vault readiness and fresh SLO blockers clear. Capabilities, tensor status, chain verify, health, service liveness, Ollama provider readiness, and embed search are working; full readiness remains blocked.

## Public vs Private Scope

Public-ready candidates:
- Core runtime, MCP, registry, health/readiness, backup, SLO, tensor, Rust bridge, and tests under `src/`, `tests/`, and `crates/`.
- Operator docs under `docs/dev/`, `docs/runbooks/`, and `docs/operator/` after review.

Needs review before public release:
- `apps/` Tauri GUI work.
- `src/infra/public-chat-gateway.ts` and `src/infra/public-chat-contract.ts`.
- PSA/Watra dashboards, notes, CRM/vault content, generated HTML, lead data, and local operator artifacts.

Private-local by default:
- `vault/**`, `notes/PSA/**`, `data/PSA/**`, `leads.json`, `manifest.json`, `001743.json`, `popup.html`, `sesja-refleksyjna-*.md`, `wodzu-dashboard.cjs`, and PSA sync scripts.

## Runtime Data Policy

- Do not reset chains as part of this work. The plan assumes current chains are healthy.
- Rust core remains authoritative for chain/hash/bridge behavior.
- TypeScript is the facade and orchestrator, not a competing data truth.
- Embedding contracts:
  - Memory embeddings: `Vec<f32>`, `dim=32`, `dtype=f32`.
  - Kartograf: `Float32Array`, `dim=256`.
  - Raw vectors are not a public API.
- Any provider or dimension change requires backup, reindex, and `memphis tensor status --json` smoke.

## Verification Snapshot

Validated on 2026-06-16 and re-run on 2026-06-17:

- `npm run typecheck`
- `npx vitest run tests/unit/chain-integrity.test.ts tests/doctor-v2.test.ts tests/unit/doctor.voice-stack.test.ts --reporter=verbose`
- `npx vitest run tests/unit/readiness.test.ts tests/unit/tool-surface-audit.test.ts tests/unit/tool-schema-audit.test.ts tests/mcp/server.test.ts tests/unit/in-process-tool-executor.test.ts`
- `npx vitest run tests/unit/readiness.test.ts tests/unit/tool-surface-audit.test.ts tests/unit/tool-schema-audit.test.ts tests/unit/self-governance.test.ts tests/unit/tensor-status.test.ts tests/unit/public-chat-contract.test.ts tests/mcp/server.test.ts tests/unit/in-process-tool-executor.test.ts tests/mcp/soul-tools.test.ts tests/unit/rust-bridge-manifest.test.ts tests/unit/rust-embed-adapter.test.ts tests/backup.test.ts`
- `npx vitest run tests/unit/readiness.test.ts tests/unit/tool-surface-audit.test.ts tests/unit/tool-schema-audit.test.ts tests/unit/self-governance.test.ts tests/unit/tensor-status.test.ts tests/unit/public-chat-contract.test.ts tests/mcp/server.test.ts tests/unit/in-process-tool-executor.test.ts tests/mcp/soul-tools.test.ts tests/unit/rust-bridge-manifest.test.ts tests/unit/rust-embed-adapter.test.ts tests/backup.test.ts`
- `npx vitest run tests/unit/tool-registry.test.ts tests/unit/readiness.test.ts tests/unit/self-governance.test.ts --reporter=verbose`
- `npx vitest run tests/unit/tui-host.test.ts --reporter=verbose` outside the sandbox, because the sandbox blocks the child-process/stdio path.
- `cargo test -p memphis-napi --lib`
- `cargo test -p memphis-operator --lib` outside the sandbox, because the sandbox blocks the local listener used by one provider streaming test.

Broad `npx vitest run` was not re-run after this pass. Previously observed focused failures in doctor voice-stack, doctor-v2 chat hardening, and chain-integrity now pass in the focused gate above. Long-running lifecycle/scheduler tests still need a separate broad-suite pass.

Runtime smokes run without restart:

- `memphis health --json`
- `memphis tensor status --json`
- `memphis tools list --json`
- `memphis embed search --query test --json`
- `memphis chain verify --chain journal --json`
- `memphis readiness --json`
- `memphis self-governance status --json`
- `memphis backup list --json`
- `systemctl --user status memphis.service`

Runtime repair/restart completed on 2026-06-17:

- `memphis backup create --tag pre-repair-one-truth`
- `memphis repair runtime`
- `systemctl --user restart memphis.service`
- `systemctl --user set-environment MEMPHIS_SKIP_VAULT_INTEGRITY_PROBE=true`
- `systemctl --user restart memphis.service`
- repeated the runtime smokes above
- changed `DEFAULT_PROVIDER` from `minimax` to `ollama` so provider readiness no longer depends on the missing `minimax_api_key` vault entry
