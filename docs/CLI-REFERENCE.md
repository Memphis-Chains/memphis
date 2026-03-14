# CLI Reference

This is the user-facing command reference for Memphis CLI.

## Global usage

```bash
memphis <command> [flags]
memphis <command> --json
memphis <command> --help
```

## Core Commands

- `setup`, `init`, `configure`
- `health`, `doctor`
- `tui`

## Ask / Inference

- `ask --input "..."`
- `ask-session --session <name> --input "..."`
- `chat --input "..."`
- `route`, `decide`, `infer`, `predict`

## Cognitive Layer

- `reflect [--save]`
- `learn [--reset]`
- `insights [--daily|--weekly|--topic <name>]`
- `categorize <text> [--save]`
- `connections scan|find --query "A,B"`
- `suggest`

## Storage / Vault / Embeddings

- `vault init|add|get|list`
- `embed store|search|reset`
- `chain import_json --file <path> [--write --confirm-write --out <path>]`
- `chain rebuild [--out <path>]`
- `chain verify [--chain <name>]`

## Sync / Federation

- `sync status [--chain <name>]`
- `sync push --chain <name>`
- `sync pull --agent <did> [--chain <name>]`
- `trade offer --recipient <did> [--blocks 1-100] [--file <path>]`
- `trade accept --offer-id <id> --file <offer.json>`

## Providers / Models

- `providers:health`
- `providers list`
- `models list`

## MCP

- `mcp serve|serve-once|serve-status|serve-stop`
- common flags: `--transport stdio|http`, `--port <n>`, `--duration-ms <n>`, `--schema`

## Backup / Ops / Debug

- `backup create|list|verify|restore|clean`
- `debug trace|profile|memory|monitor`
- `completion <bash|zsh|fish>`

## Output Modes

- `--json` for machine-readable output.
- default output is human-readable.

## Examples

```bash
memphis ask --input "summarize this project"
memphis reflect --save --json
memphis vault add --key SHARED_LLM_API_KEY --value "sk-..."
memphis sync status --chain journal --json
```

## Related docs

- `docs/CLI-COMMAND-MATRIX.md` for grouped command map
- `docs/API-REFERENCE.md` for HTTP/Gateway API
- `docs/QUICKSTART.md` for first-run flow
