# Getting Started with Memphis

This is the shortest operator path for the full solo-local Memphis runtime.

Release distribution is package-first, but the supported Rust-backed operator flow is still: clone the repository, bootstrap it locally, then run the runtime from that checkout.

## 1. Bootstrap the repo

From repository root:

```bash
npm run bootstrap
```

Bootstrap ensures:

- `.env` exists,
- `MEMPHIS_API_TOKEN` and `MEMPHIS_VAULT_PEPPER` exist,
- `RUST_CHAIN_ENABLED=true` is present,
- embed persistence is enabled,
- a local agent profile exists,
- a `systemd --user` service is installed and enabled when the host supports it,
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

Check runtime status first:

```bash
npm run -s cli -- service status
```

If bootstrap could not enable the user service, install or start Memphis manually in terminal 1:

```bash
npm run -s cli -- service install
```

If `systemd --user` is unavailable, run:

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

Channel gateways are optional and disabled by default. Enable them explicitly with `MEMPHIS_CHANNEL_GATEWAY_ENABLED=true` plus a channel token when you want Telegram delivery.

## 7. Related docs

- [README.md](../README.md)
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
- [PACKAGE-PUBLISH.md](./PACKAGE-PUBLISH.md)
- [CANONICAL-ARCHITECTURE.md](./CANONICAL-ARCHITECTURE.md)
- [EXECUTION-PLAN.md](./EXECUTION-PLAN.md)
