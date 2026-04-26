# Memphis CLI Command Reference

Complete reference of all Memphis CLI commands with descriptions, syntax, and expected operator workflow context.

## Setup

### init

First-run operator onboarding. Initializes agent identity, vault, session tokens, and provider credentials.

syntax: `memphis init [status] [--state minimal-baseline|guided-conversation] [--non-interactive] [--operator-passphrase <secret>] [--passphrase <secret>] [--recovery-question <q>] [--recovery-answer <a>]`

workflow: Run immediately after installing Memphis. Interactive by default; use `--non-interactive` for scripted deployments. Configures operator passphrase, vault encryption, and agent identity.

---

### setup matrix

Matrix pilot setup path. Alternative onboarding for Matrix-integrated deployments.

syntax: `memphis setup matrix [--server-name <name>] [--admin-user <user>] [--admin-pass <pass>]`

workflow: Use instead of `init` when deploying Memphis within an existing Matrix/Synapse infrastructure. Configures Matrix bridge credentials and server connection.

---

### setup matrix-prereqs

Validate prerequisites for Matrix setup.

syntax: `memphis setup matrix-prereqs`

workflow: Run before `setup matrix` to verify all required dependencies (Node.js, SQLite, network access to Matrix server) are available.

---

### configure

Deprecated setup wizard that writes config.yaml.

syntax: `memphis configure [--non-interactive] [--dry-run] [--passphrase <secret>] [--recovery-question <q>] [--recovery-answer <a>] [--no-vault]`

workflow: **DEPRECATED**. Use `memphis init` instead. This command writes `~/.memphis/config.yaml` which is no longer the canonical configuration source.

---

### backup

Backup Memphis data directory or restore from a previous backup.

syntax: `memphis backup [--list|--restore <id> --yes|--clean [--keep <n>]]`

workflow: Create point-in-time snapshots of runtime state including SQLite databases, chain blocks, and embeddings. Use `--list` to see available backups, `--restore <id>` to recover, `--clean` to prune old backups keeping only `--keep n` most recent.

---

## Runtime

### serve

Start the Memphis HTTP server.

syntax: `memphis serve [--telegram]`

workflow: Launch the Memphis daemon that handles API requests, work polling, and provider orchestration. Use `--telegram` to also start the Telegram gateway.

---

### doctor

Run comprehensive system diagnostics.

syntax: `memphis doctor [--fix] [--force] [--deep]`

workflow: Validate all dependencies and runtime state. Use `--fix` to automatically repair issues where possible. Use `--deep` for intensive checks including provider connectivity and disk I/O.

---

### health

Check Memphis service health.

syntax: `memphis health [--cron]`

workflow: Report current system status including runtime health, surface policies, work polling state, and local worker status. Use `--cron` for automated health checks in cron jobs.

---

### repair runtime

Attempt to repair corrupted runtime state.

syntax: `memphis repair runtime [--force] [--json]`

workflow: Run after a crash or corruption. Repairs inconsistent SQLite databases, broken chain indexes, and orphaned work items. Use `--force` to bypass confirmation prompts.

---

### kill-zombies

Terminate zombie worker processes.

syntax: `memphis kill-zombies [--dry-run] [--port <n>]`

workflow: Clean up stale or orphaned worker processes that are no longer responding. Use `--dry-run` to preview what would be killed without actually terminating.

---

### reset

Reset Memphis runtime state completely.

syntax: `memphis reset --runtime --yes [--json]`

workflow: **Destructive operation**. Removes all runtime state including databases, chain data, and agent memory. Requires `--yes` confirmation. Use when migrating to a fresh installation or recovering from unrecoverable state corruption.

---

## Memory

### embed

Manage embedding storage and search.

syntax: `memphis embed <store|search|reindex|reset> [--id <id>] [--value <text>] [--query <text>] [--top-k <n>] [--tuned] [--json]`

workflow:

- `embed store --id <memory-id> --value <content>`: Store content in durable memory with a given ID
- `embed search --query <text> [--top-k <n>] [--tuned]`: Search embedded content semantically
- `embed reindex [--chain <name>]`: Rebuild the embedding index from chain data
- `embed reset`: Clear all embeddings and reset the index

---

### search

Query Memphis chain blocks using full-text or semantic search.

syntax: `memphis search [--query <text>] [--top-k <n>] [--chain <name>] [--json]`

workflow: Search across all chain blocks for specific content. Returns matching blocks with relevance scores. Use `--chain` to limit search to a specific chain (e.g., `journal`, `decisions`).

---

### knowledge

Query the operator knowledge base.

syntax: `memphis knowledge <status|sources|query> [--topic <text>] [--source <id>] [--limit <n>] [--json]`

workflow:

- `knowledge status`: Show loaded knowledge sources and their availability
- `knowledge sources`: List all configured knowledge sources
- `knowledge query --topic <text>`: Search knowledge base for a topic

---

### reflect

Run the Memphis reflection engine to generate insights from recent chain history.

syntax: `memphis reflect [--save] [--json]`

workflow: Analyze recent decisions, actions, and conversations to generate reflective insights. Use `--save` to persist the reflection report to the journal chain.

---

### learn

Manage the Memphis learning system.

syntax: `memphis learn [--reset] [--json]`

workflow: View or reset accumulated learning data. Use `--reset` to clear all learned patterns and start fresh.

---

### insights

Generate cognitive insights from chain history.

syntax: `memphis insights [--daily|--weekly|--topic <name>] [--save] [--json]`

workflow:

- `insights --daily`: Generate daily insights from recent chain activity
- `insights --weekly`: Generate weekly trend insights
- `insights --topic <name>`: Generate topic-specific insights
- `insights --save`: Persist insight report to the journal chain

---

### connections

Discover connections between topics in the knowledge graph.

syntax: `memphis connections <scan|find> [--query "A,B"] [--json]`

workflow:

- `connections scan`: Scan chain history to discover latent connections between concepts
- `connections find <topic-a> <topic-b>`: Find explicit connections between two specific topics

---

### suggest

Generate proactive suggestions based on chain patterns.

syntax: `memphis suggest [--json]`

workflow: Analyze recent chain history and suggest next actions, topics to explore, or potential decisions. Used by the cognitive system to drive proactive behavior.

---

### categorize

Categorize text and assign Memphis-relevant tags.

syntax: `memphis categorize <text> [--save] [--json]`

workflow: Classify arbitrary text against Memphis taxonomy and emit tags. Use `--save` to persist the categorization result to the journal chain.

---

## Vault

### vault

Encrypted secret storage with passphrase protection.

syntax: `memphis vault <init|add|get|list|migrate|reset|pepper-rotate|master-key-rotate|entry-delete|recovery-unlock> [--passphrase <secret>] [--recovery-question <q>] [--recovery-answer <a>] [--key <name>] [--value <text>] [--yes] [--json]`

workflow:

- `vault init --passphrase <secret> --recovery-question <q> --recovery-answer <a>`: Initialize the vault with a master passphrase
- `vault add --key <name> --value <text>`: Store an encrypted secret
- `vault get --key <name>`: Retrieve and decrypt a secret
- `vault list [--key <prefix>]`: List stored secret metadata (not values)
- `vault migrate [--yes] [--json]`: Move legacy `${installRoot}/data/vault-{state,entries}.json` files into `${MEMPHIS_HOME ?? ~/.memphis}/`. Refuses to clobber if a target file already exists. Operators with installs predating PR #279 use this to opt-in to the new absolute-path defaults.

---

### secret

High-level secret management interface (backed by vault).

syntax: `memphis secret <add|get|list> --key <name> [--value <text>] [--json]`

workflow:

- `secret add --key <name> --value <plaintext>`: Store an encrypted secret
- `secret get --key <name>`: Retrieve and decrypt a secret
- `secret list`: List all stored secrets (metadata only)

---

### tier

Read-only inspection of tier-3 elevation sessions across surfaces (TUI, Telegram, Matrix, HTTP). Tier-3 sessions are minted by `/tier 3 <pass>` slash commands inside TUI/Telegram and grant 3-hour permission elevation (unrestricted FS, sudo, autonomy=full); this command does NOT mint or revoke sessions, only enumerates active ones.

syntax: `memphis tier <status> [--json]`

workflow:

- `tier status`: Human-readable list of active sessions with surface, actorId, granted/expires timestamps, and remaining time.
- `tier status --json`: Machine-readable JSON `{ ok, count, sessions[], asOf }` for scripting.

The command queries the daemon at `http://${HOST}:${PORT}/v1/ops/tier3/sessions` (auth-token gated). If the daemon is not running, the command surfaces an actionable error including the systemctl start hint.

---

## Chain

### chain import_json

Import chain blocks from a JSON file.

syntax: `memphis chain import_json --file <path> [--write --confirm-write --out <path>]`

workflow: Bulk import chain blocks from an external JSON file. Use `--write` to actually persist the blocks; otherwise runs as a dry-run. Output path defaults to `./data/imported-chain.json`.

---

### chain export

Export chain blocks to JSON.

syntax: `memphis chain export --chain <name> [--out <path>] [--json]`

workflow: Export all blocks from a named chain to JSON. Use `--out` to specify output file; otherwise prints to stdout.

---

### chain verify

Verify integrity of a chain.

syntax: `memphis chain verify [--chain <name>] [--json]`

workflow: Validate chain hash continuity and block signatures. Use to detect corruption or tampering.

---

### chain rebuild

Rebuild chain indexes for fast lookup.

syntax: `memphis chain rebuild [--out <path>] [--json]`

workflow: Regenerate chain indexes from raw blocks. Use after bulk imports or when index corruption causes lookup failures.

---

### soul

Soul/memory operations for the Memphis identity system.

syntax: `memphis soul <replay|step|show|manifest> [--file <path>] [--chain <name>] [--latest <n>] [--action <json>] [--state <json>] [--limits <json>] [--json]`

workflow:

- `soul replay [--file <path>] [--chain <name>] [--latest <n>]`: Replay blocks through the soul loop
- `soul step --action <json> [--state <json>] [--limits <json>]`: Execute a single soul loop step
- `soul show`: Display current soul identity and memory summary
- `soul manifest`: Show the soul manifest

---

### trade

Distributed trade protocol for exchanging chain blocks between agents.

syntax: `memphis trade <offer|accept> [--recipient <did>] [--blocks <content>] [--file <path>] [--offer-id <id>] [--json]`

workflow:

- `trade offer --recipient <did> [--blocks <content>] [--file <path>]`: Create a trade offer for a recipient
- `trade accept --file <offer.json> [--offer-id <id>]`: Accept a received trade offer

---

### sync / network

Distributed sync management for multi-agent state.

syntax: `memphis sync <status|push|pull> [--chain <name>] [--agent <did>] [--json]`

workflow:

- `sync status [--chain <name>]`: Show sync state for a chain
- `sync push [--chain <name>]`: Push local chain state to network
- `sync pull --agent <did> [--chain <name>]`: Pull chain state from a specific agent

---

## Providers

### providers list

List all configured LLM providers and their status.

syntax: `memphis providers list [--json]`

workflow: Show all configured providers (local-fallback, ollama, shared-llm, minimax, deepseek, glm, decentralized-llm) with availability and default model.

---

### providers health

Check health status of all configured providers.

syntax: `memphis providers health [--json]`

workflow: Probe each configured provider's endpoint and report connectivity status. Use to diagnose provider availability issues.

---

### models list

List all available models across configured providers.

syntax: `memphis models list [--json]`

workflow: Enumerate all models available from the configured provider cascade, including capabilities (vision, function calling, context window size).

---

### route

Show how Memphis would route a task to a provider.

syntax: `memphis route [--task-type <type>] [--priority <quality|latency>] [--min-context <n>] [--vision] [--functions] [--json]`

workflow: Display the routing decision Memphis would make for a hypothetical request with given requirements. Use for debugging routing logic and understanding provider selection.

---

### telegram

Telegram bot integration management.

syntax: `memphis telegram <configure|send|status> [--bot-token <token>] [--allowed-user-ids <ids>] [--value <message>] [--to <chat-id>] [--json]`

workflow:

- `telegram configure --bot-token <token> --allowed-user-ids <ids>`: Configure Telegram bot credentials (stored in vault)
- `telegram send --value <message> [--to <chat-id>]`: Send a message via the configured bot
- `telegram status`: Show Telegram gateway status and bot information

---

## Tools

### config tools

Manage tool permission policies.

syntax: `memphis config tools <list|allow|deny|set|check|reset|pending|approve-call|deny-call> [tool-name] [--value <policy>] [--json]`

workflow:

- `config tools list`: Show all tool permission policies
- `config tools allow <tool-name>`: Allow a specific tool
- `config tools deny <tool-name>`: Deny a specific tool
- `config tools set <tool-name> --value <allow|deny|require-approval>`: Set explicit policy
- `config tools check <tool-name>`: Check policy for a specific tool
- `config tools reset`: Remove all explicit policies (all tools allowed by default)
- `config tools pending`: List tool calls pending approval
- `config tools approve-call <request-id>`: Approve a pending tool call
- `config tools deny-call <request-id>`: Deny a pending tool call

---

### config surfaces

Manage surface policy overrides.

syntax: `memphis config surfaces <list|check|set|reset> [surface] [setting] [--value <...>] [--json]`

workflow:

- `config surfaces list`: List all surface policies and overrides
- `config surfaces check <surface>`: Show effective policy for a surface
- `config surfaces set <surface> <setting> --value <value>`: Set a surface policy override
- `config surfaces reset <surface> [setting]`: Remove surface policy overrides

---

## Cognitive

### infer

Infer decisions from chain history.

syntax: `memphis infer [--input <text>] [--json]`

workflow: Analyze chain history to infer likely next decisions. Without `--input`, shows all inferred decisions from recent history. With `--input`, runs inference on the provided text.

---

### decide

Make or record a decision.

syntax: `memphis decide --input <text> [--json] | decide history [--id <id>] [--latest <n>] [--json] | decide transition --input <DecisionRecord JSON> --to <status> [--json]`

workflow:

- `decide --input <text>`: Parse a decision signal from text and record it
- `decide history`: Show decision history
- `decide transition --input <json> --to <status>`: Transition a decision to a new status (proposed, accepted, implemented, verified, superseded, rejected)

---

### predict

Predict next likely decisions using pattern analysis.

syntax: `memphis predict [--json]`

workflow: Use predictive models to forecast likely next decisions based on chain-first cognitive patterns. Returns confidence scores and rationale.

---

### agents

Manage the agent registry.

syntax: `memphis agents <list|discover|show> [--id <did>] [--json]`

workflow:

- `agents list`: List all known agents
- `agents discover`: Discover agents on the network
- `agents show <did>`: Show detailed information for a specific agent

---

### relationships

Show agent relationship graph.

syntax: `memphis relationships show --id <did> [--json]`

workflow: Display all known relationships (trust, communication, trade) involving a specific agent identified by DID.

---

### trust

Manage tool trust rules and autonomy mode.

syntax: `memphis trust <list|add|remove|mode> [tool] [--auto-approve] [--json]`

workflow:

- `trust list`: Show all trust rules and current autonomy mode
- `trust add <tool> [--auto-approve]`: Add a trust rule for a tool
- `trust remove <tool>`: Remove a trust rule
- `trust mode set <quiet|balanced|paranoid>`: Set the autonomy mode

---

## Apps

### apps

Manage Memphis applications (managed app lifecycle).

syntax: `memphis apps <list|show|plan|run|validate|import> [id] [--action <name>] [--file <manifest.json>] [--dry-run|--apply] [--force] [--json]`

workflow:

- `apps list`: List all managed apps in the catalog
- `apps show <id>`: Show detailed manifest and registry info for an app
- `apps plan <id> [--action <name>]`: Preview what an app action would do
- `apps run <id> [--action <name>] [--apply]`: Execute an app action
- `apps validate [--file <manifest.json>]`: Validate app manifest(s)
- `apps import --file <manifest.json> [--force]`: Import a manifest into the catalog

Lifecycle aliases: `install`, `start`, `stop`, `restart`, `status`, `doctor`, `dashboard` all map to `apps run` with the respective action name.

---

## MCP

### mcp

MCP (Model Context Protocol) server operations.

syntax: `memphis mcp [serve|serve-once|serve-status|serve-stop] [--input "<json>"] [--session <name>] [--schema] [--transport stdio|http] [--port <n>] [--duration-ms <n>] [--provider <name>] [--model <id>] [--tui|--interactive] [--strategy default|latency-aware]`

workflow:

- `mcp serve [--transport stdio|http] [--port <n>] [--duration-ms <n>]`: Start MCP server (default: stdio transport)
- `mcp serve-once [--input "<json>"] [--port <n>]`: Handle a single MCP request and exit
- `mcp serve-status`: Check if MCP server is running
- `mcp serve-stop`: Stop the running MCP server
- `mcp --schema`: Print MCP JSON-RPC method schema

---

## Schedule

### schedule

Task scheduler for automated operations.

syntax: `memphis schedule <list|add|remove|enable|disable|run|help> [--cron "<pattern>"] [--name "<name>"] [--type git-pull-build|reflection|shell|http] [--value "<script|url>"] [--id <task-id>] [--runtime] [--json]`

workflow:

- `schedule list`: List all scheduled tasks
- `schedule add --cron "<pattern>" --name "<name>" --type <type>`: Create a new scheduled task
- `schedule remove --id <task-id>`: Remove a task
- `schedule enable --id <task-id>`: Enable a disabled task
- `schedule disable --id <task-id>`: Temporarily disable a task
- `schedule run --id <task-id> [--runtime]`: Run a task immediately

---

## Worker

### worker

Local worker for processing queued work items.

syntax: `memphis worker <status|once|run> [--duration-ms <n>] [--json]`

workflow:

- `worker status`: Show worker health and queue status
- `worker once`: Process one work item from the queue and exit
- `worker run [--duration-ms <n>]`: Start worker loop (runs until interrupted or duration expires)

---

## Evolve

### evolve

Evolution session management for capability growth.

syntax: `memphis evolve <status|rollback|log> [session-id] [--json]`

workflow:

- `evolve status`: List recent evolution sessions and their status
- `evolve rollback <session-id>`: Roll back to a previous snapshot
- `evolve log`: Show full evolution audit log

---

## Onboarding

### onboarding bootstrap

Automated first-run environment bootstrap.

syntax: `memphis onboarding bootstrap [--profile dev-local|prod-shared|prod-decentralized|ollama-local] [--apply] [--dry-run] [--force] [--out <path>] [--json]`

workflow: Automated setup that validates dependencies, generates `.env` from a profile template, and runs pre-flight checks. Use `--apply` to write files (requires `--yes` safety check in production).

---

### onboarding wizard

Interactive first-run setup wizard.

syntax: `memphis onboarding wizard [--interactive] [--profile <name>] [--write] [--force] [--out <path>] [--json]`

workflow: Interactive CLI wizard that walks through all setup steps. Use `--write --profile <name>` to generate `.env` from profile template non-interactively.

---

## Workspace

### workspace / context

Manage Memphis workspace context files.

syntax: `memphis workspace init [path] [--force] [--json] | workspace context sync [path] [--force] [--json]`

workflow:

- `workspace init [path]`: Scaffold `.memphis/context.json`, `AGENTS.md`, and `CLAUDE.md` in the project
- `workspace sync` / `context sync`: Refresh Memphis-managed blocks in context files

---

## Debug

### debug

Performance profiling and debugging tools.

syntax: `memphis debug <trace|profile|memory|monitor> [--format table|json|csv] [--interval <ms>] [--duration-ms <n>] [-- <command>]`

workflow:

- `debug trace -- <command>`: Trace a command's execution steps with timing
- `debug profile -- <command>`: Profile a command and identify bottlenecks
- `debug memory [--format table|json|csv]`: Inspect process memory usage
- `debug monitor [--interval <ms>] [--duration-ms <n>]`: Monitor runtime metrics over time

---

## System

### help

Show help information and operator guide.

syntax: `memphis help [--json]`

workflow: Display command usage summary and the operator guide. This is the default when running `memphis` without arguments.

---

### ascii

Display Memphis ASCII art logo.

syntax: `memphis ascii [--size small|medium|large]`

workflow: Show the Memphis creative logo. Use for branding or fun.

---

### progress

Show Memphis roadmap progress.

syntax: `memphis progress [--json]`

workflow: Display current roadmap status with milestone completion indicators.

---

### celebrate

Display a celebration message.

syntax: `memphis celebrate <milestone>`

workflow: Print a celebration message for a specific milestone achievement.

---

### guide

Display the operator guide.

syntax: `memphis guide [--json]`

workflow: Show the full operator guide with best practices and workflow recommendations.

---

### completion

Generate shell completion scripts.

syntax: `memphis completion <bash|zsh|fish>`

workflow: Output shell completion script for the specified shell. Source the output or add to shell config to enable tab completion for Memphis commands.

---

### tui

Launch the Memphis terminal UI.

syntax: `memphis tui [--check-only --json] [--run-command "<cmd>" --json]`

workflow: Start the interactive terminal UI. Use `--check-only --json` to verify TUI readiness without launching. Use `--run-command` to execute a command within the TUI environment.

---

## Cognitive / Decision

### mcp ask

Send a question to Memphis via MCP.

syntax: `memphis ask --input <text> [--provider <name>] [--model <id>] [--session <name>] [--strategy default|latency-aware] [--system-prompt <text>] [--tui] [--interactive] [--json]`

workflow: Interactive or scripted Q&A via the MCP interface. Supports provider selection, model override, and session persistence.

---

### mcp chat

Single-turn chat interaction.

syntax: `memphis chat --input <text> [--provider <name>] [--model <id>] [--strategy default|latency-aware] [--system-prompt <text>] [--tui] [--provider-only] [--json]`

workflow: Send a single chat message and receive a response. Use `--provider-only` to skip tool execution and memory.

---

### mcp ask-session

Multi-turn chat session.

syntax: `memphis ask-session [--session <name>] [--input <text>] [--provider <name>] [--model <id>] [--strategy default|latency-aware] [--system-prompt <text>] [--tui] [--interactive] [--json]`

workflow: Continue an interactive chat session with context preserved across turns. Use `--session` to name and persist sessions.

---

### mcp providers:health

Check provider health via MCP.

syntax: `memphis providers:health [--json]`

workflow: Alias for `providers health` routed through the MCP interface.

---

### explain

Query chain blocks and case entries for operator insight.

syntax: `memphis explain [--chain <name>] [--limit <n>] [--case-type <type>] [--entity <name>] [--json]`

workflow: Query recent chain blocks and case entries to understand what happened in the system. Use `--case-type` and `--entity` to filter case chain queries.

---

## Aliases

- `network` — alias for `sync`
- `context sync` — alias for `workspace sync`
- `providers:health` — handled via `interactionCommandHandler`
- `tui host` — handled within interaction command

---

## Global Flags

- `--json`: Output results in JSON format
- `--help`: Show help for a specific command
- `--yes`: Skip confirmation prompts (use with caution)
- `--force`: Force operation even if safety checks fail
- `--dry-run`: Preview operation without executing
