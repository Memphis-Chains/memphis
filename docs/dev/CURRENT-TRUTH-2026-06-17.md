# Memphis Current Truth - 2026-06-17

This is the current handoff map after the fresh runtime recovery, Minimax/Brave/Telegram restoration, SLO rebaseline, and repo private-artifact quarantine.

## Runtime Truth

- Runtime state: `initialized-clean`.
- Service: `memphis.service` active on `127.0.0.1:3000`.
- Readiness: `ok=true`; vault cipher, Rust bridge, embed pipeline, capabilities, default provider, and Telegram rows are OK.
- Default provider: `minimax` via vault entry `minimax_api_key`.
- Provider cascade: `minimax,ollama,local-fallback`.
- Brave Search: `BRAVE_API_KEY=VAULT:brave_api_key`; `memphis brave status --json` probe OK.
- Telegram: gateway enabled, bot `memphisagent_bot`, one allowlisted user id.
- Self-governance: `capable=true`, `canSelfRecover=true`, `canSelfModify=false`.
- Latest runtime backup: `working-minimax-brave-telegram-slo-2026-06-17-2026-06-17-21-04.tar.gz`.

## SLO Truth

- Pre-recovery telemetry was archived to `/home/memphis/.memphis/telemetry/archive/pre-minimax-recovery-spans-2026-06-17.jsonl`.
- Active telemetry was rebaselined after provider recovery.
- Local Minimax latency target is explicit: `MEMPHIS_SLO_TURN_P99_MS=12000`.
- SLO windows may report `unavailable` until enough fresh samples accumulate; this is not a runtime failure when `blockingReasons` is empty.

## Repo Truth

- Private/local artifacts were quarantined outside the repository at `/home/memphis/.memphis/private-quarantine/repo-cleanup-2026-06-17/`.
- Quarantine manifest: `/home/memphis/.memphis/private-quarantine/repo-cleanup-2026-06-17/manifest.tsv`.
- Quarantined categories: Tauri/apps prototype, PSA/Watra/private notes and dashboards, public-chat prototype files, private vault notes, root one-off JSON/HTML artifacts.
- `.gitignore` now blocks those local artifacts from reappearing as accidental public candidates.

## Public-Ready Candidates

- Tool registry/MCP/executor/schema parity.
- Runtime health/readiness/self-governance.
- Tensor status and Rust bridge manifest.
- SLO evaluator override and focused tests.
- Operator docs and runbooks after review.

## Deferred

- Public chat/API gateway is deferred until core repo cleanup and runtime gates remain stable.
- Tauri/apps GUI work is quarantined by default and must be explicitly reintroduced if it becomes public product work.
- Self-modification remains supervised only; `canSelfModify:false` is intentional.
