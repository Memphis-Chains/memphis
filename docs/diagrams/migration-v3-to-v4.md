# Migration Guide: v3 -> v4

## Key changes
- New unified CLI (`memphis-v4`) with richer subcommands.
- Rust bridge support for chain, vault, and embedding operations.
- Session-aware ask/recall workflow.
- Retrieval benchmark gating and trend history.

## Migration steps
1. Backup v3 data and config.
2. Install v4 and run `memphis-v4 doctor`.
3. Generate `.env` via onboarding wizard/bootstrap.
4. Import legacy chain payloads using `memphis-v4 chain import_json`.
5. Rebuild indexes via `memphis-v4 chain rebuild`.
6. Validate with smoke/e2e tests and benchmark gate.

## Compatibility notes
- Legacy `{ chain: [...] }` import payloads remain supported.
- Relative/temp paths are required for E2E portability in CI.
