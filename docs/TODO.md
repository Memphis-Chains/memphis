# Memphis — What's Left To Do

Updated: 2026-04-08

## Recently Completed

- [x] Vault-first key resolution in Rust providers (`memphis-operator`)
- [x] Flaky `memphis-napi` CI temp-dir collision fixed
- [x] Telegram defaults to full companion mode (`tier=2`) with operator guide visibility
- [x] TUI and Telegram both surface the same runtime design / guide entrypoint
- [x] Memphis Agent manifest + system prompt tuned for tools, self-modification, and operator surfaces
- [x] MCP HTTP transport now has a real `/health` endpoint and a stable default port split
- [x] Setup/onboarding now writes `MCP_PORT=3001` explicitly for localhost installs
- [x] Lifecycle self-reflection loop now runs from bootstrap, persists reflections/insights, and updates soul memory
- [x] Build/deploy pipeline now exists via `memphis_deploy` + `memphis deploy` with snapshot rollback and post-deploy health checks
- [x] Feature flags now gate preview tools via `MEMPHIS_FEATURES`, with registry/runtime/MCP filtering from one source of truth
- [x] CLI command dispatch now uses a centralized lazy-loaded registry, and top-level completion commands share that source of truth

## Current Remaining Work

Remaining work now starts at P3. The short-term P2 queue is clear.

## P3 — Open Issues

| Issue | Priority | Description                                                   |
| ----- | -------- | ------------------------------------------------------------- |
| #56   | MED      | Skills system underutilized — no skill marketplace or creator |

### Feature flags

Preview tools can now be exposed explicitly with:

`MEMPHIS_FEATURES=experimental-tools`

The same filter applies to the tool registry, in-process executor, soul
manifest capabilities, operator guide, and external MCP registration so
surfaces stay aligned.

### Operational note

For a local operator install, the recommended split is:

- API/runtime HTTP: `127.0.0.1:3000`
- External MCP over HTTP: `127.0.0.1:3001`
- Local editor/agent integration: `stdio` transport by default, not HTTP

## P4 — Roadmap Phases (big scope)

These are tracked as GitHub issues and represent major capability expansions:

| Issue | Phase   | Scope                                                                         |
| ----- | ------- | ----------------------------------------------------------------------------- |
| #46   | Phase 1 | Foundation tools — filesystem, browser, docker, web search, git, packages, db |
| #47   | Phase 2 | Cloud + IaC — AWS, GCP, Azure, Terraform, Ansible, Kubernetes                 |
| #48   | Phase 3 | Network + Security — nmap, tcpdump, Vault, Prometheus, DNS, proxy             |
| #49   | Phase 4 | Offensive Security — pentest, credential attacks, persistence, privesc        |
| #50   | Phase 5 | Skill Engine — skill DSL, AI composer, self-modification, workflow runtime    |

## Rust TUI Tool Parity Status

All 17 native tools are now implemented in the Rust TUI:

| Tier | Tool                | Status                                 |
| ---- | ------------------- | -------------------------------------- |
| 0    | memphis_journal     | done                                   |
| 0    | memphis_recall      | done                                   |
| 0    | memphis_search      | done                                   |
| 0    | memphis_health      | done                                   |
| 0    | memphis_soul_read   | done                                   |
| 0    | memphis_soul_write  | done                                   |
| 0    | memphis_case_query  | done                                   |
| 0    | memphis_case_append | done                                   |
| 0    | memphis_vault_list  | done                                   |
| 0    | memphis_chain_query | done                                   |
| 0    | memphis_decide      | done                                   |
| 1    | memphis_code_read   | done                                   |
| 1    | memphis_grep        | done                                   |
| 1    | memphis_glob        | done                                   |
| 1    | memphis_git         | done                                   |
| 1    | memphis_web_fetch   | done                                   |
| 2    | memphis_exec        | done (unrestricted)                    |
| 2    | memphis_test        | done                                   |
| 2    | memphis_self_modify | done (snapshot + rollback + test gate) |
| 2    | memphis_cron        | done (full CRUD)                       |

Tools NOT in Rust TUI (TS-only via MCP):

- memphis_embed_store, memphis_embed_search (require HNSW index)
- memphis_vault_get (requires vault unlock flow)
- memphis_send (cross-channel messaging)
- memphis_schedule_create/list/cancel (remote triggers)
