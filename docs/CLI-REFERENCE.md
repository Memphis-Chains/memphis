# CLI Reference

This is the user-facing command reference for Memphis CLI.

## Global usage

```bash
memphis <command> [flags]
memphis <command> --json
memphis <command> --help
```

## Core Commands

- `setup`, `setup matrix`, `init`, `configure`
- `health`, `doctor`
- `tui [--check-only --json]`

## Service Management

- `service status|install|logs|restart|uninstall`
- `reset --runtime --yes`
- `gateway start|stop|status`

## Ask / Inference / Decision

- `ask --input "..."`
- `ask-session --session <name> --input "..."`
- `chat --input "..."`
- `infer`, `decide`, `predict`, `route`
- `git-stats`, `agents list|discover|show`, `relationships show`
- `decision-inference`

## Cognitive Layer

- `reflect [--save]`
- `learn [--reset]`
- `insights [--daily|--weekly|--topic <name>]`
- `categorize <text> [--save]`
- `connections scan|find [--query "A,B"]`
- `suggest`
- `explain [--chain <name>] [--case-type <type>] [--entity <name>]`
- `evolve status|rollback|log`

## Storage / Vault / Embeddings

- `vault init|add|get|list`
- `embed store|search|reset|reindex [--chain <name>]`
- `chain import_json --file <path> [--write --confirm-write --out <path>]`
- `chain export --chain <name> [--out <path>]`
- `chain rebuild [--out <path>]`
- `chain verify [--chain <name>]`
- `secret add|get|list`

## Soul / Onboarding

- `soul show|manifest|memory|replay|step|seed`
- `onboarding bootstrap [--profile <name>] [--apply] [--dry-run] [--yes]`
- `onboarding wizard [--interactive] [--profile <name>] [--write --out .env] [--apply]`

## Sync / Federation

- `setup matrix [--server-name <name>] [--admin-user <user>] [--admin-pass <pass>]`
- `sync status [--chain <name>]`
- `sync push --chain <name>`
- `sync pull --agent <did> [--chain <name>]`
- `trade offer --recipient <did> [--blocks 1-100] [--file <path>]`
- `trade accept --offer-id <id> --file <offer.json>`

`setup matrix` is a bounded trusted-pilot bootstrap. It stores pilot bootstrap
secrets in the local vault and only emits
`MEMPHIS_MATRIX_ACCESS_TOKEN=VAULT:MEMPHIS_MATRIX_ACCESS_TOKEN` when it has a
real Matrix access token. If no token was acquired, the command returns
operator follow-up steps instead of reporting pilot readiness.

## Providers / Models

- `providers:health`
- `providers list`
- `models list`

## MCP

- `mcp serve|serve-once|serve-status|serve-stop`
- `mcp` (bare) — direct JSON-RPC
- common flags: `--transport stdio|http`, `--port <n>`, `--duration-ms <n>`, `--schema`

## Telegram Integration

- `telegram send --value "<message>" [--to <chatId>] [--json]`
- `telegram status [--json]`
- `gateway start|stop|status [--json]` — runtime control of the channel gateway

## Operator / Security

- `operator status [--json]` — check if passphrase is configured
- `operator set-passphrase` — enroll or change operator passphrase
- `operator recover` — reset passphrase via recovery question/answer

### Passphrase-gated operations

The following operations require operator authentication (sudo-like, 15-min session cache):

| Command     | Subcommand / Condition               |
| ----------- | ------------------------------------ |
| `vault`     | `init`                               |
| `trust`     | `add`, `remove`, `mode --target set` |
| `evolve`    | `rollback`                           |
| `backup`    | `--restore`, `--clean`               |
| `reset`     | `--runtime --yes`                    |
| `configure` | (any)                                |

Authenticate once per session: the first gated command prompts for the operator passphrase and caches the session for 15 minutes. Use `--operator-passphrase <pass>` to pass it inline.

## Backup / Ops / Debug

- `backup create|list|verify|restore|clean`
- `debug trace|profile|memory|monitor [--format table|json|csv] [--interval <ms>]`
- `completion <bash|zsh|fish>`
- `context`, `workspace`
- `guide`, `serve`, `ascii [--size small|medium|large]`, `progress`, `celebrate [milestone]`
- `apps list|show|plan|run|validate|import`
- Lifecycle aliases: `install|start|stop|restart|status|doctor|dashboard`

## Output Modes

- `--json` for machine-readable output.
- default output is human-readable.

## Rust TUI RC Sanity

- `memphis tui --check-only --json` runs a non-interactive native-console health check.
- Use it in RC drills and release proof instead of trying to drive the terminal UI through pipes.

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
