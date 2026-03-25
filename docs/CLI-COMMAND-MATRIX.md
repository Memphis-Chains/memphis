# CLI Command Matrix

Reference map for Memphis CLI command groups.

## Core Operations

- `setup`, `configure`, `init`
- `health`, `doctor`
- `tui`, `completion`

## Service Management / Runtime

- `service status|install|logs|restart|uninstall`
- `reset --runtime --yes`
- `gateway start|stop|status`

## Telegram

- `telegram send --value "<msg>" [--to <chatId>]`
- `telegram status`

## Backup & Recovery

- `backup` (defaults to `create`)
- `backup create|list|verify|restore|clean`

## Debug & Diagnostics

- `debug trace|profile|memory|monitor`
- `providers:health`, `providers list`, `models list`

## AI / Inference / Decision

- `chat`, `ask`, `ask-session`, `route`, `decide`, `infer`, `predict`
- `git-stats`, `agents list|discover|show`, `relationships show`
- `explain`, `evolve status|rollback|log`

## Memory & Vault

- `vault init|add|get|list`
- `secret add|get|list`
- `embed store|search|reset|reindex [--chain <name>]`
- `reflect`, `learn`, `insights`
- `soul show|manifest|memory|replay|step|seed`
- `onboarding bootstrap|wizard`

## Collaboration / Network

- `agents list|discover|show`
- `relationships show`, `trust`
- `sync status|push|pull`
- `trade offer|accept`

## MCP

- `mcp serve|serve-once|serve-status|serve-stop`

## Operator / Security

- `operator status|set-passphrase|recover`
- passphrase-gated: `vault init`, `trust add|remove`, `evolve rollback`, `backup --restore|--clean`, `reset --runtime`, `configure`

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
memphis backup --help
```
