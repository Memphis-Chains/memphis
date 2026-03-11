# Memphis v5 Troubleshooting Guide

![Support](https://img.shields.io/badge/support-self--hosted-informational)
![Scope](https://img.shields.io/badge/scope-Ubuntu%2FWSL%20Linux%20x64-blue)

This guide covers common installation/runtime issues and practical fixes.

---

## 1) Fast diagnostic sequence

Run in repository root and capture output:

```bash
node -v
npm -v
rustc --version
cargo --version
npm run -s cli -- doctor --json
npm run -s cli -- health --json
npm run -s cli -- doctor --verbose
```

If needed, include:

```bash
npm test
npm run build
```

---

## 2) Build failures

## 2.1 `node` version too low

**Symptom**
- install/build scripts fail with Node version error

**Fix**

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

## 2.2 Rust toolchain missing

**Symptom**
- `cargo: command not found`

**Fix**

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable
source "$HOME/.cargo/env"
```

## 2.3 Native module compile error (toolchain)

**Symptom**
- build fails around C/C++ bindings or native dependencies

**Fix**

```bash
sudo apt-get update
sudo apt-get install -y build-essential pkg-config libssl-dev
npm rebuild
npm run build
```

## 2.4 `memphis` not found after `npm link`

**Fix**

```bash
npm link
hash -r
which memphis
```

If still missing, add npm global bin to `PATH`.

---

## 3) Runtime errors

## 3.1 Configuration errors

**Symptom**
- startup fails: `Invalid configuration` or provider key missing

**Cause**
- `DEFAULT_PROVIDER` selected but required provider variables unset

**Fix**
- Either set provider values in `.env`, or switch to local fallback:

```dotenv
DEFAULT_PROVIDER=local-fallback
LOCAL_FALLBACK_ENABLED=true
```

Then run:

```bash
npm run -s cli -- doctor --json
```

Memphis now emits actionable error codes with suggested fixes for:
- missing `.env`
- missing Ollama
- invalid API keys
- network failures
- permission errors

Stack traces stay hidden by default. Add `--verbose` when you need the full stack.

## 3.2 Production safety check failure

**Symptom**
- error: `MEMPHIS_API_TOKEN is required in production`

**Fix**

```dotenv
NODE_ENV=production
MEMPHIS_API_TOKEN=replace-with-strong-secret
```

## 3.3 Database path errors

**Symptom**
- SQLite open failure / missing directory

**Fix**

```bash
mkdir -p data
# verify DATABASE_URL, e.g.
# DATABASE_URL=file:./data/memphis-v5.db
```

## 3.4 Ollama missing or not running

**Symptom**
- doctor warns or fails with `MISSING_OLLAMA`

**Fix**

```bash
ollama serve
ollama pull nomic-embed-text
npm run -s cli -- doctor
```

---

## 4) Performance issues

## 4.1 Slow generation responses

Actions:
1. Reduce `GEN_MAX_TOKENS`
2. Lower `GEN_TIMEOUT_MS` only if provider is stable
3. Check provider health

```bash
npm run -s cli -- providers:health
npm run -s cli -- health --json
```

## 4.2 Slow embedding/search

Actions:
- reduce `RUST_EMBED_MAX_TEXT_BYTES`
- validate remote embedding endpoint latency
- clear and rebuild embedding state if needed

```bash
npm run -s cli -- embed reset
npm run -s cli -- embed store --id test --value "performance baseline"
npm run -s cli -- embed search --query "baseline" --top-k 5 --tuned
```

## 4.3 WSL filesystem bottleneck

If repo is under `/mnt/c/...`, move it to Linux FS (`~/...`) for better performance.

---

## 5) Sync and chain problems

## 5.1 Chain query/rebuild inconsistency

Run index rebuild:

```bash
npm run -s cli -- chain rebuild
```

If importing external chain data, verify input schema and write flags:

```bash
npm run -s cli -- chain import_json --file ./export.json --write --confirm-write
```

## 5.2 Sync pull/push issues

Verify target agent and chain names:

```bash
npm run -s cli -- sync status --chain journal
npm run -s cli -- agents list
```

Start with small block ranges in trade flows:

```bash
npm run -s cli -- trade offer --recipient did:example:agent123 --blocks 1-20
```

---

## 6) Security concerns

## 6.1 Secret leakage prevention

- Never commit `.env`
- Rotate exposed provider/API keys immediately
- Use restrictive permissions:

```bash
chmod 600 .env
```

## 6.2 Unsafe gateway `/exec` configuration

Keep restricted mode enabled in production:

```dotenv
GATEWAY_EXEC_RESTRICTED_MODE=true
GATEWAY_EXEC_ALLOWLIST=echo,pwd,ls,whoami,date,uptime
```

## 6.3 Vault errors

If vault commands fail, confirm:
- `MEMPHIS_VAULT_PEPPER` is set
- `MEMPHIS_VAULT_ENTRIES_PATH` is writable

---

## 7) Recovery checklist

1. Backup data directory
2. Restore conservative `.env` (local-fallback)
3. Run `doctor` + `health`
4. Run `npm run build && npm test`
5. Re-enable advanced provider/sync features gradually

---

## 8) When escalating

When opening an issue, include:
- OS + version (Ubuntu/WSL)
- `node -v`, `npm -v`, `rustc --version`, `cargo --version`
- failing command and full output
- sanitized `.env` (without secrets)

Related docs:
- [INSTALLATION.md](./INSTALLATION.md)
- [GETTING-STARTED.md](./GETTING-STARTED.md)
- [CONFIGURATION.md](./CONFIGURATION.md)
- [ARCHITECTURE.md](./ARCHITECTURE.md)
