# CLI Command Matrix

Reference map for Memphis CLI command groups.

## Core Operations

- `init` (canonical controlled first-run)
- `setup matrix` (optional Matrix trusted-pilot bootstrap)
- `health`, `doctor`
- `repair runtime [--force]`
- `tui [--check-only --json]`, `completion`

## Service Management / Runtime

- `service status|install|logs|restart|uninstall`
- `reset --runtime --yes`
- `repair runtime [--force]`

## Telegram

- `telegram send --value "<msg>" [--to <chatId>]`
- `telegram status`
- inbound Telegram chat is env-driven through `MEMPHIS_CHANNEL_GATEWAY_ENABLED=true`

## Backup & Recovery

- `backup` (defaults to `create`)
- `backup create|list|verify|restore|clean`

## Debug & Diagnostics

- `debug trace|profile|memory|monitor`
- `providers:health`, `providers list`, `models list`
- `git-stats` (legacy git debug only; not part of runtime memory truth)

## AI / Inference / Decision

- `chat`, `ask`, `ask-session`, `route`, `decide`, `infer`, `predict` (chain-first defaults)
- `agents list|discover|show`, `relationships show`
- `explain`, `evolve status|rollback|log`

## Memory & Vault

- `vault init|add|get|list`
- `secret add|get|list`
- `chain import_json|export|rebuild|verify`
- `embed store|search|reset|reindex [--chain <name>]`
- `reflect`, `learn`, `insights`
- `soul show|manifest|memory|replay|step|seed`
- `init [status] [--state minimal-baseline|guided-conversation]`
- `setup` is an alias to `init`; `configure` and `onboarding wizard|bootstrap` remain legacy/internal only

## Collaboration / Network

- `agents list|discover|show`
- `relationships show`, `trust`
- `sync status|push|pull`
- `trade offer|accept`

## MCP

- `mcp serve|serve-once|serve-status|serve-stop`

## Operator / Security

- `operator status|set-passphrase|recover`
- passphrase-gated: `vault init`, `trust add|remove`, `evolve rollback`, `backup --restore|--clean`, `reset --runtime`, `configure` (legacy)

Canonical first-run flow:

```bash
npm run bootstrap
memphis init
memphis health --json
memphis tui
```

## Misc

- `ascii [--size small|medium|large]`, `progress`, `celebrate [milestone]`
- `guide`, `serve`, `context`, `workspace`
- `apps list|show|plan|run|validate|import` (aliases: `install|start|stop|restart|status|doctor|dashboard`)
- bare `mcp` — direct JSON-RPC

## Quick verification examples

```bash
memphis backup list
memphis backup verify <id-or-file>
memphis debug trace "node -v"
memphis doctor --json
```

For full usage syntax, run:

```bash
memphis --help
memphis tui --check-only --json
memphis backup --help
```
