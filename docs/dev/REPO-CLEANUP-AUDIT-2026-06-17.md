# Repo Cleanup Audit - 2026-06-17

No files were deleted. Private/local candidates were moved to an operator-local quarantine outside the repo.

## Pre-Cleanup Snapshot

- Runtime readiness: OK.
- Self-governance: `capable=true`, `canSelfRecover=true`, `canSelfModify=false`.
- Provider health: default provider `minimax`; `minimax`, `ollama`, and `local-fallback` OK.
- Dirty tree before quarantine contained staged additions under `apps/`, PSA/Watra artifacts, private `vault/` notes, and public-chat prototype files.
- Latest known good backup before cleanup: `working-minimax-brave-telegram-slo-2026-06-17-2026-06-17-21-04.tar.gz`.

## Quarantine

- Location: `/home/memphis/.memphis/private-quarantine/repo-cleanup-2026-06-17/`.
- Manifest: `/home/memphis/.memphis/private-quarantine/repo-cleanup-2026-06-17/manifest.tsv`.
- Rule: quarantine means move-and-manifest, not delete.

## Quarantined Buckets

- GUI/Tauri prototype: `apps/`.
- PSA/private operator artifacts: `data/PSA/`, `notes/PSA/`, `notes/PSA-struktura-*.md`, `crons/adapt-psa.sh`, `tools/sync-psa.sh`.
- Private notes/data: `vault/`, `leads.json`, `manifest.json`, `001743.json`, `popup.html`, `sesja-refleksyjna-*.md`, `wodzu-dashboard.cjs`.
- Deferred product prototype: `src/infra/public-chat-gateway.ts`, `src/infra/public-chat-contract.ts`, `tests/unit/public-chat-contract.test.ts`.
- Watra dashboard prototype: `src/dashboard/watra-dashboard.ts`.

## Current Public Scope

- Keep core runtime/readiness/health/backup/SLO changes.
- Keep tool registry/MCP/executor/schema parity changes.
- Keep Rust bridge/tensor/self-governance changes.
- Keep focused tests for the above.

## Restore Note

To restore a quarantined item, copy or move it from the quarantine path listed in `manifest.tsv` back to its original path, then remove the corresponding ignore rule only if it should become public source.
