# CLI Command Matrix

Reference map for Memphis CLI command groups.

## Core Operations

- `setup`, `configure`, `init`
- `health`, `doctor`
- `tui`, `completion`

## Backup & Recovery

- `backup` (defaults to `create`)
- `backup create|list|verify|restore|clean`

## Debug & Diagnostics

- `debug trace|profile|memory|monitor`
- `providers:health`, `providers list`, `models list`

## AI / Inference

- `chat`, `ask`, `ask-session`, `route`, `decide`, `infer`, `predict`

## Memory & Vault

- `vault init|add|get|list`
- `embed store|search|reset`
- `reflect`, `learn`, `insights`

## Collaboration / Network

- `agents list|discover|show`
- `relationships show`, `trust`
- `sync status|push|pull`
- `trade offer|accept`

## MCP

- `mcp serve|serve-once|serve-status|serve-stop`

## Misc

- `ascii`, `progress`, `celebrate`

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
