# Memphis — What's Left To Do

Updated: 2026-04-07

## Completed This Session (v1.3.0+)

- [x] Anthropic provider in Rust TUI (native Messages API, SSE streaming)
- [x] Tier 1 tools: code_read, grep, glob, git (read-only), web_fetch
- [x] Tier 2 tools: exec (unrestricted), test, self_modify (snapshot/rollback), cron (full CRUD)
- [x] `memphis_chain_query` and `memphis_decide` tools in Rust TUI
- [x] Full autonomy mode bypasses all exec blocklists (TS + Rust)
- [x] Installer works without Zig (falls back to system cc/c++/ar)
- [x] Install path fixed (`~/memphis` not `~/.memphis/memphis`)
- [x] `appendFileSync` bug fixed in memory.ts
- [x] TUI always tier 2 (operator surface)
- [x] Dead code warnings cleaned
- [x] HOW-TO-USE.md quick reference

## P2 — Short-term

### Vault-first key resolution in Rust providers
Rust TUI providers (`provider.rs`) read API keys from env vars only.
They should check the vault first, falling back to env.
This would let the TUI use keys stored via `memphis vault store` without
exporting env vars.

### Flaky `memphis-napi` tests in CI
The `testRust` preflight gate intermittently fails on GitHub Actions
(passes locally every time). The failure is in `memphis-napi` lib tests
but the CI log truncates the actual test output. Needs investigation of
the CI runner environment — likely a timing or resource issue.

## P3 — Open Issues

| Issue | Priority | Description |
|-------|----------|-------------|
| #54   | HIGH     | No build/deploy pipeline or health check tools |
| #61   | MED      | No feature flag system for experimental tools |
| #62   | MED      | CLI has no centralized command registry with lazy loading |
| #57   | MED      | No automatic self-reflection loop |
| #56   | MED      | Skills system underutilized — no skill marketplace or creator |

### #54 — Build/deploy pipeline
Memphis can self-modify and test, but has no tool for building Docker
images, pushing to registries, or deploying to remote hosts. The cron
system + exec tool can be composed for this, but a dedicated
`memphis_deploy` tool with rollback would be safer.

### #57 — Self-reflection loop
The cron scripts for `reflection` and `insights` exist in `crons/` but
the reflection loop isn't wired into the soul lifecycle. Memphis should
periodically review its own journal, extract patterns, and update soul
memory without operator prompting.

### #61 — Feature flags
Experimental tools (offensive security, cloud IaC) need gating so they
can be developed on main without breaking stable users. A simple
`MEMPHIS_FEATURES=flag1,flag2` env var would suffice initially.

## P4 — Roadmap Phases (big scope)

These are tracked as GitHub issues and represent major capability expansions:

| Issue | Phase | Scope |
|-------|-------|-------|
| #46   | Phase 1 | Foundation tools — filesystem, browser, docker, web search, git, packages, db |
| #47   | Phase 2 | Cloud + IaC — AWS, GCP, Azure, Terraform, Ansible, Kubernetes |
| #48   | Phase 3 | Network + Security — nmap, tcpdump, Vault, Prometheus, DNS, proxy |
| #49   | Phase 4 | Offensive Security — pentest, credential attacks, persistence, privesc |
| #50   | Phase 5 | Skill Engine — skill DSL, AI composer, self-modification, workflow runtime |

## Rust TUI Tool Parity Status

All 17 native tools are now implemented in the Rust TUI:

| Tier | Tool | Status |
|------|------|--------|
| 0 | memphis_journal | done |
| 0 | memphis_recall | done |
| 0 | memphis_search | done |
| 0 | memphis_health | done |
| 0 | memphis_soul_read | done |
| 0 | memphis_soul_write | done |
| 0 | memphis_case_query | done |
| 0 | memphis_case_append | done |
| 0 | memphis_vault_list | done |
| 0 | memphis_chain_query | done |
| 0 | memphis_decide | done |
| 1 | memphis_code_read | done |
| 1 | memphis_grep | done |
| 1 | memphis_glob | done |
| 1 | memphis_git | done |
| 1 | memphis_web_fetch | done |
| 2 | memphis_exec | done (unrestricted) |
| 2 | memphis_test | done |
| 2 | memphis_self_modify | done (snapshot + rollback + test gate) |
| 2 | memphis_cron | done (full CRUD) |

Tools NOT in Rust TUI (TS-only via MCP):
- memphis_embed_store, memphis_embed_search (require HNSW index)
- memphis_vault_get (requires vault unlock flow)
- memphis_send (cross-channel messaging)
- memphis_schedule_create/list/cancel (remote triggers)
