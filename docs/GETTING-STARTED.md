# Getting Started with Memphis

Shortest path from zero to a running Memphis instance.

**Supported**: Linux x64 (Ubuntu 22.04+, WSL2, Docker). Requires Node.js 22+ and Rust stable.

## 1. Install

### One-liner (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/Memphis-Chains/memphis/main/scripts/install.sh | bash
```

Installs all prerequisites, clones the repo, builds everything, and sets up systemd service.

### Manual (source checkout + bootstrap)

```bash
git clone https://github.com/Memphis-Chains/memphis.git ~/.memphis/memphis
cd ~/.memphis/memphis
npm run bootstrap
```

## 2. Initialize

```bash
memphis init
```

Guided flow: operator passphrase, vault initialization, first-state mode selection, health summary.

## 3. Connect a provider

### Anthropic (recommended)

```bash
# Browser OAuth — opens browser, you log in, token stored automatically
memphis auth anthropic
```

Or use an API key:

```bash
memphis vault add --key anthropic_api_key --value "sk-ant-..."
```

Then in `.env`:
```dotenv
DEFAULT_PROVIDER=anthropic
ANTHROPIC_MODEL=claude-sonnet-4-6
```

### Ollama (local, offline)

```bash
ollama pull qwen2.5-coder:3b
ollama pull nomic-embed-text
```

Memphis auto-detects Ollama. Set `DEFAULT_PROVIDER=ollama` in `.env` if you want it as primary.

### Other cloud providers

```bash
memphis vault add --key deepseek_api_key --value "sk-..."
memphis vault add --key minimax_api_key --value "sk-..."
```

## 4. Verify

```bash
memphis doctor            # Should show PASS
memphis health --json     # Quick health check
```

## 5. Start the runtime

```bash
memphis service status    # Check if already running
memphis service restart   # Start/restart
```

If systemd is unavailable:
```bash
npm run dev               # Foreground mode
```

## 6. Open the console

```bash
memphis tui               # Native Rust terminal UI
```

Or use the HTTP API:
```bash
TOKEN=$(grep '^MEMPHIS_API_TOKEN=' .env | cut -d= -f2-)

curl -X POST http://127.0.0.1:3030/api/journal \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"content":"First memory entry","tags":["test"]}'
```

## 7. Write and recall memory

```bash
# CLI
memphis embed store --id note-1 --value "Guest prefers quiet room"
memphis embed search --query "quiet room" --top-k 5
memphis search --query "Guest prefers quiet room"

# Semantic recall vs exact search
# embed search = vector similarity (fuzzy)
# search       = FTS5 exact match (precise)
```

## 8. Enable full autonomy (optional)

For unattended operation without approval prompts:

```dotenv
MEMPHIS_AUTONOMY_MODE=full
```

This auto-approves all tool tiers and bypasses the passphrase gate. See [USER-GUIDE.md](./USER-GUIDE.md#autonomy-modes) for details.

## 9. Setup Matrix federation (optional)

```bash
memphis setup matrix --json
```

Registers a Matrix pilot for multi-agent federation. Memphis stores credentials in vault.

## 10. Enable Telegram (optional)

```dotenv
MEMPHIS_CHANNEL_GATEWAY_ENABLED=true
MEMPHIS_TELEGRAM_BOT_TOKEN=your-bot-token
MEMPHIS_TELEGRAM_CHAT_ID=your-chat-id
MEMPHIS_TELEGRAM_ALLOWED_USER_IDS=your-user-id
```

```bash
memphis service restart
memphis telegram status
```

## What you get

- Agent identity from profile + soul manifest
- 19 MCP tools across 3 tiers (0, 1, 2)
- Durable chain memory (journal, decisions, reflections, patterns, cases, system, collective)
- Semantic embeddings + exact FTS5 recall
- Vault-encrypted secrets with Rust NAPI bridge
- Automatic provider fallback (Anthropic -> Ollama -> local-fallback)
- Five cognitive modes (A-E)
- systemd service + native Rust TUI

## Related docs

- [USER-GUIDE.md](./USER-GUIDE.md) — full operator manual
- [CANONICAL-ARCHITECTURE.md](./CANONICAL-ARCHITECTURE.md) — system architecture
- [CLI-REFERENCE.md](./CLI-REFERENCE.md) — all CLI commands
- [RUNTIME-STATE-MODEL.md](./RUNTIME-STATE-MODEL.md) — state model
