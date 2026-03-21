# Getting Started with Memphis

This is the shortest operator path that matches the current runtime contract.

## 1. Bootstrap the repo

From repository root:

```bash
npm run bootstrap
```

Bootstrap ensures:

- `.env` exists,
- `MEMPHIS_API_TOKEN` and `MEMPHIS_VAULT_PEPPER` exist,
- embed persistence is enabled,
- a local agent profile exists,
- the repo root is initialized as a workspace.

## 2. Initialize the vault

```bash
npm run -s cli -- vault init \
  --passphrase "your-secret" \
  --recovery-question "your question" \
  --recovery-answer "your answer"
```

This is a one-time action for a local runtime.

## 3. Verify operator health

```bash
npm run -s cli -- doctor --fix
npm run -s cli -- health --json
npm run -s cli -- guide
```

`guide` prints the current operator story: identity source, tools, memory, vault, and next commands.

## 4. Start the runtime

In terminal 1:

```bash
npm run dev
```

In terminal 2:

```bash
npm run -s cli -- tui
```

## 5. Write and recall durable memory

### CLI

```bash
npm run -s cli -- embed store --id note-1 --value "Guest prefers quiet room"
npm run -s cli -- embed search --query "quiet room" --top-k 5
```

`embed store` is chain-backed. It writes auditable memory first and indexes the same content for recall.

### HTTP

```bash
TOKEN=$(grep '^MEMPHIS_API_TOKEN=' .env | cut -d= -f2-)

curl -X POST http://127.0.0.1:3000/api/journal \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"content":"Guest prefers quiet room","tags":["guest","preference"]}'

curl -X POST http://127.0.0.1:3000/api/recall \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query":"quiet room","limit":5}'
```

## 6. What to expect

At this point Memphis should give you:

- a local agent identity from agent profile or env,
- visible tools via `guide` and gateway runtime,
- durable memory through journal + embeddings,
- vault-backed secrets,
- one coherent path across bootstrap, CLI, TUI, and HTTP.

## 7. Related docs

- [README.md](../README.md)
- [CANONICAL-ARCHITECTURE.md](./CANONICAL-ARCHITECTURE.md)
- [EXECUTION-PLAN.md](./EXECUTION-PLAN.md)
