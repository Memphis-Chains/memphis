# CLI Commands Review - MemphisOS

## Registered Handlers (in dispatcher.ts order)

### 1. `apps` — Managed Applications
**Handler:** `appsCommandHandler` → `commands/apps.ts`

Subcommands:
- `memphis apps list` — List all managed app manifests
- `memphis apps show <id>` — Show manifest details
- `memphis apps plan <id> [--action <name>]` — Plan app action (dry-run)
- `memphis apps run <id> --action <name> [--dry-run|--apply] [--file <manifest.json>]` — Execute app action
- `memphis apps validate [--file <manifest.json>]` — Validate manifest(s)
- `memphis apps import --file <manifest.json> [--force]` — Import manifest into catalog
- `memphis apps install|start|stop|restart|status|doctor|dashboard <id> [--dry-run|--apply] [--file <manifest.json>]` — Lifecycle aliases

---

### 2. `config` — Tool Permissions & Approvals
**Handler:** `configCommandHandler` → `handlers/config.handler.ts`

Subcommands:
- `memphis config tools list` — List all tool permissions
- `memphis config tools allow <tool-name>` — Allow a tool
- `memphis config tools deny <tool-name>` — Deny a tool
- `memphis config tools set <tool-name> --value <allow|deny|require-approval>` — Set explicit policy
- `memphis config tools check <tool-name>` — Check tool permission status
- `memphis config tools reset` — Reset all to default (allow)
- `memphis config tools pending` — List pending tool call approvals
- `memphis config tools approve-call <request-id>` — Approve pending call
- `memphis config tools deny-call <request-id>` — Deny pending call

---

### 3. `system` — Built-in Commands (many subcommands)
**Handler:** `systemCommandHandler` → `handlers/system.handler.ts` + `commands/setup.ts`, `commands/configure.ts`, `commands/backup.ts`, `commands/workspace.ts`, `commands/service.ts`

Commands without subcommands (system built-ins):
- `memphis help` / `memphis --help` — Show help
- `memphis serve` — Start the Memphis server
- `memphis doctor [--fix --force --deep]` — Run health checks
- `memphis providers health` — Check provider health
- `memphis providers list` — List configured providers
- `memphis models list` — List available models
- `memphis route [--task-type <type>] [--priority <quality|low-latency>] [--min-context <n>] [--vision] [--functions]` — Route a task to provider/model
- `memphis ascii [--size small|medium|large]` — Show Memphis ASCII logo
- `memphis progress` — Show roadmap progress
- `memphis celebrate <milestone>` — Print celebration
- `memphis guide` — Show operator guide
- `memphis completion <bash|zsh|fish>` — Generate shell completions
- `memphis health` — Service health check
- `memphis tui` — Launch terminal UI

Setup/Init commands:
- `memphis setup|init [--out .env --force]` — Setup wizard
- `memphis configure [--non-interactive] [--dry-run]` — Configure Memphis
- `memphis onboarding wizard [--interactive] [--profile dev-local|prod-shared|prod-decentralized|ollama-local] [--write --out .env --force]` — Interactive setup wizard
- `memphis onboarding bootstrap [--profile <name>] [--apply --yes] [--dry-run]` — Bootstrap host environment

Backup/Workspace:
- `memphis backup [--list|--restore <id>|--clean [--keep <n>]] [--yes]` — Backup management
- `memphis workspace` — Workspace management
- `memphis context` — Context management
- `memphis service status|install|logs|restart|uninstall [--latest <n>]` — Service management
- `memphis reset --runtime --yes` — Reset runtime state

---

### 4. `embed` — Embeddings Storage & Search
**Handler:** `embedCommandHandler` → `handlers/embed.handler.ts`

Subcommands:
- `memphis embed store --id <memory-id> --value <content>` — Store embedding
- `memphis embed search --query <text> [--top-k <n>] [--tuned]` — Search embeddings
- `memphis embed reindex [--chain <name>]` — Reindex chain blocks into embeddings
- `memphis embed reset` — Reset embeddings index

---

### 5. `vault` — Encrypted Secret Storage
**Handler:** `vaultCommandHandler` → `handlers/vault.handler.ts`

Subcommands:
- `memphis vault init --passphrase <pass> --recovery-question <q> --recovery-answer <a> [--force]` — Initialize vault
- `memphis vault add --key <name> --value <plaintext>` — Add secret
- `memphis vault get --key <name>` — Get & decrypt secret
- `memphis vault list [--key <name>]` — List secrets

---

### 6. `storage` — Chain, Onboarding, Trade, Soul
**Handler:** `storageCommandHandler` → `handlers/storage.handler.ts`

**Chain subcommands:**
- `memphis chain import_json --file <path> [--write --confirm-write --out <path>]` — Import JSONL chain blocks
- `memphis chain rebuild [--out <path>]` — Rebuild chain indexes
- `memphis chain verify [--chain <name>]` — Verify chain integrity

**Soul subcommands:**
- `memphis soul show` — Show soul manifest & memory summary
- `memphis soul manifest` — Show full soul manifest
- `memphis soul memory` — Show soul memory
- `memphis soul replay [--chain <name>] [--file <path>] [--latest <n>]` — Replay soul from chain
- `memphis soul step --action <json> [--state <json>] [--limits <json>]` — Execute soul loop step
- `memphis soul seed` — Seed new soul identity

**Trade subcommands:**
- `memphis trade offer --recipient <did> [--blocks <content>|--file <path>]` — Create trade offer
- `memphis trade accept --offer-id <id> --file <offer.json>` — Accept trade offer

---

### 7. `decision` / `infer` / `decide` / `predict` / `agents` / `relationships` / `trust`
**Handler:** `decisionCommandHandler` → `commands/decision.ts`

Subcommands:
- `memphis infer [--input <text>] [--days <n>] [--repo-path <path>]` — Infer decisions from text or git history
- `memphis decide --input <text>` — Make a decision from text input
- `memphis decide history [--id <decision-id>] [--latest <n>]` — Decision history
- `memphis decide transition --input <DecisionRecord JSON> --to <status>` — Transition decision status
- `memphis predict [--repo-path <path>]` — Predict next decision
- `memphis git-stats [--days <n>] [--repo-path <path>]` — Git statistics
- `memphis agents list` — List registered agents
- `memphis agents discover` — Discover agents on network
- `memphis agents show <did>` — Show agent details
- `memphis relationships show <did>` — Show agent relationships
- `memphis trust <did>` — Calculate trust score for agent

---

### 8. `mcp` — Model Context Protocol
**Handler:** `mcpCommandHandler` → `commands/mcp.ts`

Subcommands:
- `memphis mcp serve [--transport stdio|http] [--port <n>] [--duration-ms <n>]` — Start MCP server
- `memphis mcp serve-once [--port <n>] [--input <json>] [--provider auto|shared-llm|decentralized-llm|local-fallback] [--model <id>]` — Single request via MCP
- `memphis mcp serve-status` — Check if MCP server is running
- `memphis mcp serve-stop` — Stop MCP server
- `memphis mcp --input <jsonrpc-request>` — Direct JSON-RPC request (method: `memphis.ask`)

---

### 9. `cognitive` / `reflect` / `learn` / `insights` / `connections` / `suggest` / `categorize`
**Handler:** `cognitiveCommandHandler` → `commands/cognitive.ts`

Subcommands:
- `memphis reflect [--save]` — Generate reflection report
- `memphis learn [--reset]` — Learning statistics
- `memphis insights [--daily|--weekly|--topic <name>] [--save]` — Generate insights
- `memphis insights --query <topic> [--save]` — Topic-specific insights
- `memphis connections scan` — Scan for connections between topics
- `memphis connections find "topicA" "topicB"` / `--query "A,B"` — Find connections between two topics
- `memphis suggest` — Get proactive suggestions
- `memphis categorize <text> [--save]` — Categorize text and suggest tags

---

### 10. `sync` / `network` — Sync Management
**Handler:** `syncCommandHandler` → `commands/sync.ts`

Subcommands:
- `memphis sync status [--chain <name>]` — Show sync status
- `memphis sync push --chain <name>` — Push chain to network
- `memphis sync pull --agent <did> [--chain <name>]` — Pull chain from agent

---

### 11. `ask` / `chat` / `ask-session` / `tui` / `providers:health`
**Handler:** `interactionCommandHandler` → `commands/interaction.ts`

Subcommands:
- `memphis chat --input <text> [--provider auto|shared-llm|decentralized-llm|local-fallback] [--model <id>] [--strategy default|latency-aware] [--json|--tui]` — Single chat turn
- `memphis ask --input <text> [...]` — Alias for chat
- `memphis ask-session --session <name> --input <text> [--interactive] [...]` — Multi-turn session
- `memphis ask-session --session <name> --interactive [...]` — Interactive session mode
- `memphis tui [--provider <provider>] [--model <model>] [--strategy <strategy>]` — Launch terminal UI
- `memphis providers:health` — Check all providers health

---

### 12. `trust` — Autonomy & Trust Rules
**Handler:** `trustCommandHandler` → `handlers/trust.handler.ts`

Subcommands:
- `memphis trust list` — List trust rules
- `memphis trust add <tool> [--auto-approve]` — Add trust rule
- `memphis trust remove <tool>` — Remove trust rule
- `memphis trust mode` — Show autonomy mode (quiet|balanced|paranoid)
- `memphis trust mode set <quiet|balanced|paranoid>` — Set autonomy mode

---

### 13. `evolve` — Evolution Sessions
**Handler:** `evolveCommandHandler` → `handlers/evolve.handler.ts`

Subcommands:
- `memphis evolve status` — List recent evolution sessions
- `memphis evolve rollback <session-id>` — Rollback to snapshot
- `memphis evolve log` — Audit log of all sessions

---

### 14. `explain` — Chain/Case Query
**Handler:** `explainCommandHandler` → `commands/explain.ts`

Subcommands:
- `memphis explain <query> [--chain journal] [--limit <n>]` — Query chain blocks
- `memphis explain --case-type <type> --entity <name> [--limit <n>]` — Query case chain

---

### 15. `debug` — Profiling & Diagnostics
**Handler:** `debugCommandHandler` → `commands/debug.ts`

Subcommands:
- `memphis debug trace <command> [--format table|json|csv]` — Trace command execution steps
- `memphis debug profile <command> [--format table|json|csv]` — Profile command with bottleneck analysis
- `memphis debug memory [--format table|json|csv]` — Memory inspection
- `memphis debug monitor [--interval <ms>] [--duration-ms <n>] [--format table|json|csv]` — Runtime monitoring

---

### 16. `operator` — Operator Passphrase Management
**Handler:** `operatorCommandHandler` → `handlers/operator.handler.ts`

Subcommands:
- `memphis operator status` — Check if operator is configured
- `memphis operator set-passphrase` — Enroll or change passphrase
- `memphis operator recover` — Recover using recovery question

---

### 17. `secret` — Secret Management (vault-backed)
**Handler:** `secretCommandHandler` → `handlers/secret.handler.ts`

Subcommands:
- `memphis secret add --key <name> --value <plaintext>` — Store encrypted secret
- `memphis secret get --key <name>` — Retrieve & decrypt secret
- `memphis secret list [--key <name>]` — List secret keys

---

### 18. `telegram` — Telegram Bot Integration
**Handler:** `telegramCommandHandler` → `handlers/telegram.handler.ts`

Subcommands:
- `memphis telegram send --value <message> [--to <chatId>]` — Send Telegram message
- `memphis telegram status` — Check Telegram configuration

---

## Summary by Category

**Agent Interaction:** `ask`, `chat`, `ask-session`, `tui`
**Cognitive:** `reflect`, `learn`, `insights`, `connections`, `suggest`, `categorize`
**Decision Making:** `infer`, `decide`, `predict`, `git-stats`, `agents`, `relationships`, `trust`
**Storage/Chain:** `chain` (import_json, rebuild, verify), `soul` (show, manifest, memory, replay, step, seed), `trade` (offer, accept)
**Secrets/Vault:** `vault` (init, add, get, list), `secret` (add, get, list)
**Tool Policy:** `config tools` (list, allow, deny, set, check, reset, pending, approve-call, deny-call)
**Trust/Autonomy:** `trust` (list, add, remove, mode)
**MCP:** `mcp` (serve, serve-once, serve-status, serve-stop)
**Sync:** `sync` (status, push, pull)
**Embeddings:** `embed` (store, search, reindex, reset)
**Apps:** `apps` (list, show, plan, run, validate, import, lifecycle commands)
**Debug:** `debug` (trace, profile, memory, monitor)
**System:** `serve`, `doctor`, `providers`, `models`, `route`, `ascii`, `progress`, `celebrate`, `guide`, `completion`, `health`, `tui`
**Setup:** `setup`, `init`, `configure`, `onboarding` (wizard, bootstrap)
**Ops:** `backup`, `workspace`, `context`, `service`, `reset`, `operator`
**Explain:** `explain` (chain query, case query)
**Evolve:** `evolve` (status, rollback, log)
**Telegram:** `telegram` (send, status)
