# Memphis v5 Developer Guide

## 1) Project Structure

High-level layout:

- `src/infra/cli/` — CLI parser, dispatcher, command handlers
- `src/infra/http/` — Fastify HTTP server, route contracts, auth/rate limiting
- `src/modules/orchestration/` — provider orchestration logic
- `src/providers/` — provider clients + routing strategy
- `src/infra/storage/` — chain/vault/embed adapters
- `src/sync/` — multi-agent sync protocol and conflict resolution
- `src/mcp/` — MCP server and transports
- `src/cache/` — query/file cache implementations
- `crates/` — Rust workspace (`memphis-vault`, `memphis-napi`, etc.)
- `scripts/` — install, smoke tests, ops tooling
- `docs/` — operational and technical documentation

Build artifacts:
- `dist/` generated TypeScript output

---

## 2) Adding New CLI Commands

Dispatch pipeline:
1. parse args
2. build `CliContext`
3. run handlers in order (`dispatcher.ts`)

To add a command:
1. implement command logic in `src/infra/cli/commands/<name>.ts`
2. add/extend a handler in `src/infra/cli/handlers/`
3. register handler in `src/infra/cli/dispatcher.ts`
4. update help text in `commands/system.ts`
5. add tests for parser + behavior

Quick check:
```bash
npm run -s cli -- help
npm run -s cli -- <your-command> --json
```

---

## 3) Creating Providers

Provider contracts are under `src/providers/` and orchestration modules.

Typical steps:
1. implement provider client (`health()`, `generate()` style API)
2. wire env/config keys
3. register provider in provider factory/capability matrix
4. ensure fallback behavior works in orchestration
5. add health and integration tests

Design expectations:
- typed request/response
- normalized error mapping (`AppError`)
- timeout handling
- usage/timing metadata

---

## 4) Plugin / MCP Development

MCP tools are registered in:
- `src/mcp/server.ts`

Current tools:
- `memphis_journal`
- `memphis_recall`
- `memphis_decide`

HTTP transport:
- `src/mcp/transport/http.ts` (`/mcp` endpoint)

To add a new MCP tool:
1. implement runtime function (prefer reusable command/service logic)
2. add input schema (`zod`)
3. register tool in `createMemphisMcpServer()`
4. add docs + smoke tests for both stdio/http transport

---

## 5) HTTP API Development

Main server:
- `src/infra/http/server.ts`

When adding endpoint:
1. define validation schema in `src/infra/config/request-schemas.ts`
2. add route handler
3. update auth policy (`auth-policy.ts`) if needed
4. classify rate limiting sensitivity (`rate-limit.ts` usage)
5. return consistent error envelope (`handleHttpError`)
6. document endpoint in `docs/API-REFERENCE.md`

---

## 6) Testing Guidelines

Core commands:
```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:rust
```

Additional runtime checks:
- targeted smoke tests in `scripts/smoke-*.sh`
- release smoke: `npm run release:smoke`

For API changes:
- add contract tests for happy/error paths
- include auth/rate-limit checks where relevant

For Rust bridge changes:
- run cargo workspace tests
- verify TS↔Rust adapter compatibility

---

## 7) Contributing Workflow

Recommended workflow (aligned with project conventions):
1. **Commit 1**: foundation/contracts
2. **Commit 2**: hardening/tests
3. **Commit 3**: docs/evidence
4. open **1 PR** with risk + rollback notes

Before PR:
- ensure green quality gates
- update docs/changelog for user-visible changes
- do not commit secrets

Reference:
- `CONTRIBUTING.md`

---

## 8) Local Dev Tips

- use `npm run dev` for quick TS iteration
- use `npm run -s cli -- doctor --json` after config changes
- keep sample `.env` in sync with new required vars
- prefer explicit types over implicit `any`
- keep CLI human output and `--json` output both stable
