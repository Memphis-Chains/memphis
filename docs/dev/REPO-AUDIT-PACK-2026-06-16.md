# Repo Audit Pack - 2026-06-16

Generated from `/home/memphis/memphis` before any deletion or cleanup. No files were removed.

## Freeze Commands

- `git status --porcelain=v1`
- `git diff --stat`
- `git diff --name-status`
- `git diff --cached --name-status`
- `git ls-files --others --exclude-standard`

## Dirty Tree Summary

- Worktree is dirty with staged and unstaged changes.
- `git diff --stat` currently reports 41 tracked files changed, 1828 insertions, 200 deletions.
- There are many staged additions under `apps/`, `src/`, `tests/`, `notes/`, `vault/`, and local PSA/Watra artifacts.
- Untracked additions include tensor docs/handler/status, self-governance status, public chat contract, and focused tests.

## Disposition Map

| Scope | Paths | Disposition |
| --- | --- | --- |
| Core runtime/readiness/health/backup/SLO | `src/infra/cli/commands/readiness.ts`, `src/infra/http/health.ts`, `src/infra/cli/commands/backup.ts`, `src/infra/observability/instrument.ts`, `src/observability/slo-evaluator.ts`, related tests | keep, public-ready after full test run |
| Tool registry/MCP/executor/schema | `src/gateway/tool-registry.ts`, `src/gateway/tool-executor.ts`, `src/gateway/tool-json-schema.ts`, `src/gateway/tool-schema-audit.ts`, `src/gateway/tool-surface-audit.ts`, `src/mcp/server.ts`, `tests/unit/tool-*.test.ts`, `tests/mcp/server.test.ts` | keep, public-ready |
| Rust NAPI/bridge/tensors | `crates/memphis-napi/src/lib.rs`, `src/infra/storage/rust-bridge-manifest.ts`, `src/infra/storage/rust-embed-adapter.ts`, `src/infra/tensors/**`, `src/infra/cli/handlers/tensor.handler.ts`, `src/mcp/tools/tensor-status.ts`, tensor tests/docs | keep, public-ready after Rust tests |
| Self-governance | `src/infra/runtime/self-governance.ts`, `src/mcp/tools/self-governance-status.ts`, `src/infra/cli/handlers/self-governance.handler.ts`, `tests/unit/self-governance.test.ts` | keep, public-ready after runtime smoke |
| Public chat/API gateway | `src/infra/public-chat-gateway.ts`, `src/infra/public-chat-contract.ts`, `tests/unit/public-chat-contract.test.ts` | needs-review; public product is last phase |
| GUI/Tauri/apps | `apps/**`, `src/dashboard/watra-dashboard.ts` | needs-review; do not publish by default |
| Operator/private artifacts | `vault/**`, `notes/PSA/**`, `notes/PSA-struktura-2026-05-17.md`, `data/PSA/**`, `leads.json`, `manifest.json`, `001743.json`, `popup.html`, `sesja-refleksyjna-2026-06-08.md`, `wodzu-dashboard.cjs`, `crons/adapt-psa.sh`, `tools/sync-psa.sh` | private-local unless operator explicitly approves |
| Config/build metadata | `.env.example`, `Cargo.toml`, `Cargo.lock`, `scripts/run-rust.sh`, `crates/memphis-operator/**` | keep, needs final review |

## Notable Untracked Files

- `docs/dev/TENSOR-ARCHITECTURE.md`
- `notes/memphis-20-part-audit-2026-06-09.md`
- `src/infra/cli/handlers/tensor.handler.ts`
- `src/infra/public-chat-contract.ts`
- `src/infra/runtime/self-governance.ts`
- `src/infra/cli/handlers/self-governance.handler.ts`
- `src/infra/tensors/status.ts`
- `src/infra/tensors/types.ts`
- `src/mcp/tools/self-governance-status.ts`
- `src/mcp/tools/tensor-status.ts`
- `tests/unit/mcp-grep.test.ts`
- `tests/unit/public-chat-contract.test.ts`
- `tests/unit/self-governance.test.ts`
- `tests/unit/tensor-status.test.ts`

## Cleanup Rule

Do not delete or unstage private/operator artifacts automatically. Move them out of public release scope only after an explicit operator decision.
