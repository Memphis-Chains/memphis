# Memphis Clean Install

This is the shortest **fresh-install** path for a new user who wants the full
local Memphis runtime, not just the packaged CLI.

Use this when:

- you are installing Memphis for the first time
- you want the canonical GitHub/source-first runtime path
- you want a clean reinstall after removing or archiving older local state

Do not use GitHub Packages or the package tarball as the primary full-runtime
path. Those are bounded distribution surfaces. The full local runtime path is
still source checkout plus bootstrap.

## 1. Prerequisites

Memphis currently expects:

- Node.js `22 LTS` or newer
- Rust stable
- `git`
- `curl`
- Ollama optional but recommended for local models

Full prerequisite details:

- [INSTALL.md](../INSTALL.md)
- [docs/INSTALLATION.md](./INSTALLATION.md)

## 2. Start from a clean machine or clean runtime

If you are reinstalling after previous testing, either:

- archive the old runtime state and start clean, or
- use the reinstall guide first

Reinstall/cleanup guide:

- [docs/RE-INSTALL.md](./RE-INSTALL.md)

## 3. Clone and bootstrap

```bash
git clone https://github.com/Memphis-Chains/memphis.git
cd memphis
npm run bootstrap
```

`bootstrap` is technical install/build only. It:

- prepares `.env`
- generates runtime secrets
- builds Rust and TypeScript
- prepares local service/runtime wiring

It does **not** silently create meaningful identity or soul state.

## 4. Run controlled first-run

```bash
npm run -s cli -- init
```

If `memphis` is already on your `PATH`, the same step is:

```bash
memphis init
```

`init` is the canonical operator-first step. It handles:

- vault initialization
- operator passphrase enrollment
- first-state mode selection
- preview/confirmation of initial chain writes
- first-run status recording

## 4b. Configure Providers and Channels (optional)

Cloud providers (MiniMax, DeepSeek, GLM) and Telegram use vault-first secrets.
Run after `init`:

```bash
# Cloud LLM providers — stores API keys encrypted in vault
memphis provider add minimax --api-key sk-xxx
memphis provider add deepseek --api-key sk-xxx
memphis provider add glm --api-key sk-xxx

# Telegram bot (private 1:1) — stores token and allowlist in vault
memphis telegram configure --bot-token <token> --allowed-user-ids <user_id>
```

Verify vault resolution:
```bash
npm run -s cli -- doctor --json | grep -E 't2-minimax|t2-deepseek|t2-glm|t2-telegram'
```

## 5. Verify runtime health

```bash
npm run -s cli -- health --json
npm run -s cli -- doctor --fix
```

What you want to see:

- first-run is complete
- repair status is healthy or clearly explained
- chain memory is ready
- runtime is usable without hidden setup steps

## 6. Start using Memphis

Foreground runtime:

```bash
npm run dev
```

Native TUI:

```bash
npm run -s cli -- tui
```

Quick durable-memory test:

```bash
npm run -s cli -- embed store --id note-1 --value "Memphis clean install test"
npm run -s cli -- search --query "Memphis clean install test" --top-k 5 --chain journal
npm run -s cli -- embed search --query "clean install test" --top-k 5
```

## 7. What this proves

If the flow above works, you have verified:

- clean source install works
- first-run is controlled and explicit
- Memphis can write durable chain-backed memory
- exact and semantic recall are both wired
- the current GitHub/main docs path matches the real product path

## Related docs

- [README.md](../README.md)
- [PROJECT-STATUS.md](./PROJECT-STATUS.md)
- [ROADMAP-CURRENT.md](./ROADMAP-CURRENT.md)
- [GUIDE-FIRST-BOOTSTRAP.md](./GUIDE-FIRST-BOOTSTRAP.md)
- [GETTING-STARTED.md](./GETTING-STARTED.md)
