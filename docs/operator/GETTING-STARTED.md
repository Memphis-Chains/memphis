# Getting Started with Memphis

Shortest path from zero to a working local Memphis runtime.

Supported baseline:

- Linux x64
- Ubuntu 22.04+ or WSL2 Ubuntu
- Node.js 22+
- Rust stable

The active operator story is source checkout plus `bootstrap -> init -> health -> tui`.

## 1) Clone and bootstrap

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
npm run bootstrap
```

`bootstrap` prepares `.env`, generates runtime secrets, builds Rust and
TypeScript, and wires the local runtime. It does not silently create meaningful
vault or identity state.

## 2) Run controlled first-run

```bash
memphis init
```

Guided flow:

- operator passphrase
- vault initialization
- first-state mode selection
- preview and confirmation of first chain writes
- first-run summary

## 3) Connect a provider

### Anthropic (browser OAuth)

```bash
memphis auth anthropic
```

### Ollama (local / offline)

```bash
ollama pull qwen2.5-coder:3b
ollama pull nomic-embed-text
```

Set `DEFAULT_PROVIDER=ollama` in `.env` if you want local Ollama as primary.

### Other cloud providers

```bash
memphis provider add minimax --api-key sk-xxx
memphis provider add deepseek --api-key sk-xxx
memphis provider add glm --api-key sk-xxx
```

## 4) Verify runtime state

```bash
memphis init status --json
memphis doctor --json
memphis health --json
```

Expected result:

- `init status` shows first-run is complete
- `doctor` returns `ok=true` on a healthy configured machine
- `health` reports `runtimeStatus: "healthy"`

## 5) Start the runtime

If `systemd --user` is available:

```bash
memphis service install
memphis service restart
```

If `systemd --user` is unavailable:

```bash
npm run dev
```

## 6) Open the operator console

```bash
memphis tui
```

HTTP runtime defaults:

- runtime/API: `http://127.0.0.1:3000`
- external MCP over HTTP: `http://127.0.0.1:3001`

Quick API smoke:

```bash
TOKEN=$(grep '^MEMPHIS_API_TOKEN=' .env | cut -d= -f2-)
curl -s http://127.0.0.1:3000/health \
  -H "Authorization: Bearer $TOKEN"
```

## 7) Write and recall memory

```bash
memphis embed store --id note-1 --value "Guest prefers quiet room"
memphis embed search --query "quiet room" --top-k 5
memphis search --query "Guest prefers quiet room"
```

- `embed search` = semantic/vector recall
- `search` = exact FTS5 search

## 8) Optional follow-up

### Matrix trusted-pilot setup

```bash
memphis setup matrix --json
```

### Telegram companion setup

```bash
memphis telegram configure --bot-token <token> --allowed-user-ids <user_id>
memphis telegram status
```

## What you get

- source-backed local runtime
- controlled first-run through `memphis init`
- vault-backed provider and Telegram secrets
- durable chain memory
- exact and semantic recall
- native Rust TUI
- optional background service when `systemd --user` is available

## Related docs

- [INSTALLATION.md](./INSTALLATION.md)
- [CLEAN-INSTALL.md](./CLEAN-INSTALL.md)
- [USER-QUICKSTART-GITHUB.md](./USER-QUICKSTART-GITHUB.md)
- [USER-GUIDE.md](./USER-GUIDE.md)
- [CLI-REFERENCE.md](./CLI-REFERENCE.md)
