# User Actions Review - All APIs and Commands (No Code Required)

## 1. CLI COMMANDS

### Core Setup & Configuration
| Command | Syntax | Description |
|---------|--------|-------------|
| **setup / init** | `memphis setup [--out <path>] [--force] [--json]` | Interactive first-time setup wizard - generates .env, agent profile, vault pepper, operator passphrase enrollment |
| **configure** | `memphis configure [--dry-run] [--non-interactive] [--json]` | MVP setup wizard - configures provider, embeddings, vault state directory |

### Runtime Operations
| Command | Syntax | Description |
|---------|--------|-------------|
| **serve** | `memphis serve` | Start Memphis HTTP server (bootstrap + Fastify) |
| **service status** | `memphis service status [--json]` | Show systemd user service status |
| **service install** | `memphis service install [--json]` | Install systemd user service |
| **service restart** | `memphis service restart [--json]` | Restart the systemd service |
| **service logs** | `memphis service logs [--latest <n>] [--json]` | Read service logs |
| **service uninstall** | `memphis service uninstall [--json]` | Uninstall the service |
| **reset** | `memphis reset --runtime --yes [--json]` | Remove all runtime state and uninstall service |

### Chat & Interaction
| Command | Syntax | Description |
|---------|--------|-------------|
| **chat** | `memphis chat --input <text> [--provider <name>] [--model <id>] [--strategy <default|latency-aware>] [--session <id>] [--json] [--tui]` | Single chat turn |
| **ask** | `memphis ask --input <text> [--session <id>] [--interactive] [--provider] [--model] [--strategy] [--json]` | Ask with session support |
| **ask-session** | `memphis ask-session [--provider <name>] [--model <id>] [--strategy <s>] [--maxTokens <n>] [--contextWindow <n>] [--temperature <f>] [--systemPrompt <text>]` | Start interactive multi-turn ask session |
| **tui** | `memphis tui [--provider <name>] [--model <id>] [--strategy <s>]` | Launch full interactive TUI |
| **providers:health** | `memphis providers:health [--json]` | Show health status of all configured LLM providers |

### Cognitive Engine
| Command | Syntax | Description |
|---------|--------|-------------|
| **cognitive learn** | `memphis cognitive learn [--reset] [--json]` | Record/reset learning statistics |
| **cognitive insights** | `memphis cognitive insights [--weekly] [--query <topic>] [--save] [--json]` | Generate daily/weekly/topic insights |
| **cognitive connections scan** | `memphis cognitive connections scan [--json]` | Scan for knowledge connections |
| **cognitive connections find** | `memphis cognitive connections find <topicA> <topicB> [--json]` | Find connections between two topics |
| **cognitive suggest** | `memphis cognitive suggest [--json]` | Generate proactive suggestions |
| **cognitive categorize** | `memphis cognitive categorize "<text>" [--save] [--json]` | Categorize text and suggest tags |
| **cognitive reflect** | `memphis cognitive reflect [--save] [--json]` | Generate daily reflection report |

### Decision & Trust
| Command | Syntax | Description |
|---------|--------|-------------|
| **decision predict** | `memphis decision predict [--json]` | Predict next decision |
| **decision git-stats** | `memphis decision git-stats [--days <n>] [--json]` | Show git-based decision statistics |
| **decision infer** | `memphis decision infer [--input <text>] [--days <n>] [--json]` | Infer decisions from git history or text |
| **decision agents list** | `memphis decision agents list [--json]` | List registered agents |
| **decision agents discover** | `memphis decision agents discover [--json]` | Discover available agents |
| **decision agents show** | `memphis decision agents show --id <did> [--json]` | Show agent details |
| **decision relationships show** | `memphis decision relationships show --id <did> [--json]` | Show agent relationships |
| **decision trust** | `memphis decision trust <did> [--json]` | Calculate trust score for DID |
| **decision decide** | `memphis decision decide --input <text> [--json]` | Process decision signal from text |
| **decision decide history** | `memphis decision decide history [--id <id>] [--latest <n>] [--json]` | Show decision history |
| **decision decide transition** | `memphis decision decide transition --input <json> --to <status> [--json]` | Transition a decision record |

### Vault & Secrets
| Command | Syntax | Description |
|---------|--------|-------------|
| **vault init** | `memphis vault init --passphrase <s> --recovery-question <q> --recovery-answer <a> [--json]` | Initialize encrypted vault |
| **vault encrypt** | `memphis vault encrypt --plaintext <text> [--json]` | Encrypt a value |
| **vault decrypt** | `memphis vault decrypt --cipher <text> [--json]` | Decrypt a value |
| **vault list** | `memphis vault list [--json]` | List vault entries |
| **vault show** | `memphis vault show --id <name> [--json]` | Show a specific vault entry |
| **vault verify** | `memphis vault verify [--json]` | Verify vault integrity |

### Embeddings & Storage
| Command | Syntax | Description |
|---------|--------|-------------|
| **embed index** | `memphis embed index [--reindex] [--json]` | Index/reindex all embedded content |
| **embed search** | `memphis embed search --query <text> [--topK <n>] [--json]` | Search embedded content |

### Workspace & Context
| Command | Syntax | Description |
|---------|--------|-------------|
| **workspace init** | `memphis workspace init [path] [--force] [--json]` | Scaffold .memphis/context.json + AGENTS.md + CLAUDE.md |
| **workspace sync** | `memphis workspace sync [path] [--force] [--json]` | Refresh Memphis-managed blocks in workspace files |
| **context sync** | `memphis context sync [path] [--force] [--json]` | Alias for workspace sync |

### Sync
| Command | Syntax | Description |
|---------|--------|-------------|
| **sync status** | `memphis sync status [--chain <name>] [--json]` | Show sync status for a chain |
| **sync push** | `memphis sync push [--chain <name>] [--json]` | Push local chain changes |
| **sync pull** | `memphis sync pull --agent <did> [--chain <name>] [--json]` | Pull chain from a peer agent |

### Apps (Managed Apps)
| Command | Syntax | Description |
|---------|--------|-------------|
| **apps list** | `memphis apps list [--json]` | List all app manifests in catalog |
| **apps show** | `memphis apps show <id> [--file <manifest.json>] [--json]` | Show app manifest details |
| **apps plan** | `memphis apps plan <id> [--action <name>] [--file <manifest.json>] [--json]` | Dry-run an app action |
| **apps run** | `memphis apps run <id> [--action <name>] [--dry-run|--apply] [--file <manifest.json>] [--json]` | Execute an app action |
| **apps validate** | `memphis apps validate [--file <manifest.json>] [--json]` | Validate app manifest(s) |
| **apps import** | `memphis apps import --file <manifest.json> [--force] [--json]` | Import a manifest into catalog |
| **apps install/start/stop/restart/status/doctor/dashboard** | `memphis apps <action> <id> [--dry-run|--apply] [--file <manifest.json>] [--json]` | Lifecycle aliases |

### MCP (Model Context Protocol)
| Command | Syntax | Description |
|---------|--------|-------------|
| **mcp serve** | `memphis mcp serve [--transport stdio|http] [--port <n>] [--durationMs <n>] [--json]` | Start MCP server |
| **mcp serve-once** | `memphis mcp serve-once [--port <n>] [--input <jsonrpc>] [--json]` | Start MCP, send one request, stop |
| **mcp serve-status** | `memphis mcp serve-status [--json]` | Show MCP server status |
| **mcp serve-stop** | `memphis mcp serve-stop [--json]` | Stop MCP server |
| **mcp** | `memphis mcp --input <jsonrpc-payload> [--json]` | Direct JSON-RPC request (method: memphis.ask) |
| **mcp --schema** | `memphis mcp --schema [--json]` | Print MCP JSON-RPC schema |

### Backup & Restore
| Command | Syntax | Description |
|---------|--------|-------------|
| **backup create** | `memphis backup create [--tag <name>] [--json]` | Create a backup archive |
| **backup list** | `memphis backup list [--json]` | List all backups with metadata |
| **backup verify** | `memphis backup verify <file> [--json]` | Verify backup checksum and integrity |
| **backup restore** | `memphis backup restore <file> [--yes] [--json]` | Restore from backup (interactive confirm) |
| **backup clean** | `memphis backup clean [--keep <n>] [--dry-run] [--json]` | Remove old backups |

### Debug & Observability
| Command | Syntax | Description |
|---------|--------|-------------|
| **debug trace** | `memphis debug trace <command> [--format table|json|csv]` | Trace command execution steps |
| **debug profile** | `memphis debug profile <command> [--format table|json|csv]` | Profile command performance |
| **debug memory** | `memphis debug memory [--format table|json|csv]` | Inspect process memory usage |
| **debug monitor** | `memphis debug monitor [--interval <ms>] [--durationMs <ms>] [--format table|json|csv]` | Monitor runtime metrics |

### Explain & Case Chain
| Command | Syntax | Description |
|---------|--------|-------------|
| **explain** | `memphis explain "<query>" [--chain <name>] [--limit <n>]` | Query chain blocks by text |
| **explain --case-type** | `memphis explain --case-type <type> [--entity <name>] [--limit <n>]` | Query case chain entries |

---

## 2. HTTP API ENDPOINTS

Base URL: `http://<host>:<port>` (default: `http://127.0.0.1:3000`)

### Chat & Generation
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/chat/generate` | Generate chat response. Body: `{ input?: string, messages?: ChatMessage[], systemPrompt?: string, provider?: string, model?: string, sessionId?: string, options?: object, strategy?: string }` |

### Chat Completions (OpenAI-compatible)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/chat/completions` | OpenAI-compatible chat completions. Body: `{ messages: ChatMessage[], system?: string, model?: string, tools?: Tool[], temperature?: number, maxTokens?: number }` |

### Configuration (Chain-Journaled)
| Method | Path | Description |
|--------|------|-------------|
| POST | `/v1/config/set` | Set a config key-value. Body: `{ key: string, value: string }` |
| GET | `/v1/config/get?key=<key>` | Get latest config value |
| GET | `/v1/config/list` | List all config keys |
| GET | `/v1/config/history?key=<key>` | Get change history for a key |
| DELETE | `/v1/config/delete` | Tombstone a config key. Body: `{ key: string }` |

### Memory / Journal
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/journal` | Append to memory journal. Body: `{ content: string, tags?: string[], chain?: string }` |
| POST | `/api/recall` | Semantic search in memory. Body: `{ query: string, limit?: number (1-100), userId?: string, tags?: string[] }` |

### Tasks
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/tasks/status` | Get task queue snapshot |
| GET | `/api/tasks/pending` | List pending tasks |

### Analytics
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/analytics` | Get runtime analytics (uptime, memory, providers, chain, queue, etc.) |

### Webhooks
| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/webhooks/ingest` | Receive webhook events. Body: `{ event_id, source, event_type, payload? }` |
| GET | `/api/webhooks/events` | List webhook events (optional `?status=pending|processing|completed|failed`) |
| POST | `/api/webhooks/retry` | Retry failed event. Body: `{ event_id: string }` |

### Federation / Peers
| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/federation/health` | Check federation readiness (vault + DID signing) |
| POST | `/api/federation/peers/register` | Register a peer agent. Body: `{ did, name?, endpoint, capabilities? }` |
| POST | `/api/federation/peers/heartbeat` | Update peer presence. Body: `{ did }` |
| GET | `/api/federation/peers` | List peer agents (optional `?status=online|offline|unknown`) |

---

## 3. TUI (Terminal User Interface)

Launched via: `memphis tui` or `memphis chat --interactive`

**In-TUI Commands:**
| Command | Description |
|---------|-------------|
| `/help` | Show TUI header with current state |
| `/provider <name|auto>` | Switch LLM provider (auto, ollama, shared-llm, decentralized-llm, local-fallback) |
| `/strategy <default|latency-aware>` | Switch generation strategy |
| `/model <model-id>` | Set specific model |
| `/health` | Show provider health status |
| `/exit` or `/quit` | Exit TUI |

---

## 4. ENVIRONMENT VARIABLES (Configuration without code)

| Variable | Description | Values |
|----------|-------------|--------|
| `MEMPHIS_API_TOKEN` | API authentication token | string |
| `DEFAULT_PROVIDER` | Primary LLM provider | `ollama`, `local-fallback`, `shared-llm`, `decentralized-llm` |
| `OLLAMA_URL` | Ollama server URL | URL |
| `OLLAMA_MODEL` | Ollama model name | string |
| `SHARED_LLM_API_BASE` | Shared LLM API base URL | URL |
| `SHARED_LLM_API_KEY` | Shared LLM API key | string |
| `DECENTRALIZED_LLM_API_BASE` | Decentralized LLM API base | URL |
| `DECENTRALIZED_LLM_API_KEY` | Decentralized LLM API key | string |
| `LOCAL_FALLBACK_ENABLED` | Enable local fallback | `true`, `false` |
| `GEN_TIMEOUT_MS` | Generation timeout | milliseconds |
| `GEN_MAX_TOKENS` | Max tokens per generation | number |
| `GEN_TEMPERATURE` | Generation temperature | float (0-2) |
| `RUST_CHAIN_ENABLED` | Enable Rust chain adapter | `true`, `false` |
| `RUST_EMBED_MODE` | Embedding mode | `local`, `ollama`, `openai-compatible`, `cohere`, `voyage`, `jina`, `mistral`, `together`, `nvidia`, `mixedbread` |
| `RUST_EMBED_DIM` | Embedding dimensions | number |
| `RUST_EMBED_PERSIST_PATH` | Embed index file path | path |
| `MEMPHIS_VAULT_PEPPER` | Vault encryption pepper | string |
| `MEMPHIS_CHANNEL_GATEWAY_ENABLED` | Enable Telegram/Discord gateway | `true`, `false` |
| `MEMPHIS_TELEGRAM_BOT_TOKEN` | Telegram bot token | string |
| `MEMPHIS_SAFE_MODE` | Restrict write operations | `true`, `false` |
| `MEMPHIS_STRICT_MODE` | Fail-closed on policy violations | `true`, `false` |
| `MEMPHIS_RATE_LIMIT_GLOBAL_MAX` | Global rate limit | requests/min |
| `MEMPHIS_RATE_LIMIT_SENSITIVE_MAX` | Sensitive endpoint rate limit | requests/min |

---

## Summary

- **~60+ CLI commands** covering setup, chat, cognitive, decisions, vault, embeddings, sync, apps, MCP, backup, debug
- **~20 HTTP endpoints** for chat, config, memory, tasks, analytics, webhooks, federation
- **Interactive TUI** with runtime provider/strategy switching
- **40+ environment variables** for runtime configuration
- **Total: ~100+ distinct user-facing actions without writing any code**
