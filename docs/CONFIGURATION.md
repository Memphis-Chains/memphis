# Memphis v5 Configuration Guide

![Config](https://img.shields.io/badge/config-.env%20%2B%20schema-informational)
![Security](https://img.shields.io/badge/security-production%20checks-critical)

This guide explains runtime configuration for Memphis v5 on Ubuntu/WSL.

---

## 1) Configuration sources and precedence

Memphis loads configuration from:
1. Process environment variables
2. `.env` file (`dotenv/config`)
3. Zod schema defaults (when a key is missing)

Validation is strict. Invalid or incomplete required values fail startup.

---

## 2) Quick start

```bash
cp .env.example .env
```

Recommended safe development baseline:

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
LOG_LEVEL=info
LOG_FORMAT=text

DEFAULT_PROVIDER=local-fallback
LOCAL_FALLBACK_ENABLED=true

DATABASE_URL=file:./data/memphis-v5.db
RUST_CHAIN_ENABLED=false
```

Validate:

```bash
npm run -s cli -- doctor --json
```

---

## 3) Environment variables (`.env`)

## Core runtime

| Variable | Type | Default | Notes |
|---|---|---|---|
| `NODE_ENV` | enum | `development` | `development`, `test`, `production` |
| `HOST` | string | `0.0.0.0` | API bind host |
| `PORT` | int | `3000` | 1-65535 |
| `LOG_LEVEL` | enum | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | enum | `text` | `text` or `json` |

## Provider and generation

| Variable | Type | Default | Notes |
|---|---|---|---|
| `DEFAULT_PROVIDER` | enum | `shared-llm` | `shared-llm`, `decentralized-llm`, `local-fallback` |
| `SHARED_LLM_API_BASE` | string | - | Required if `DEFAULT_PROVIDER=shared-llm` |
| `SHARED_LLM_API_KEY` | string | - | Required if `DEFAULT_PROVIDER=shared-llm` |
| `DECENTRALIZED_LLM_API_BASE` | string | - | Required if `DEFAULT_PROVIDER=decentralized-llm` |
| `DECENTRALIZED_LLM_API_KEY` | string | - | Required if `DEFAULT_PROVIDER=decentralized-llm` |
| `LOCAL_FALLBACK_ENABLED` | bool | `true` | Local fallback provider toggle |
| `GEN_TIMEOUT_MS` | int | `30000` | 100-120000 |
| `GEN_MAX_TOKENS` | int | `512` | 1-32768 |
| `GEN_TEMPERATURE` | float | `0.4` | 0.0-2.0 |

## Storage and chain bridge

| Variable | Type | Default | Notes |
|---|---|---|---|
| `DATABASE_URL` | string | `file:./data/memphis-v5.db` | SQLite URL |
| `RUST_CHAIN_ENABLED` | bool | `false` | Enables Rust chain bridge path |
| `RUST_CHAIN_BRIDGE_PATH` | string | `./crates/memphis-napi` | Bridge location |

## Embeddings runtime

| Variable | Type | Default | Notes |
|---|---|---|---|
| `RUST_EMBED_MODE` | enum | `local` | local/provider/ollama/openai-compatible/etc. |
| `RUST_EMBED_DIM` | int | `32` | 1-4096 |
| `RUST_EMBED_MAX_TEXT_BYTES` | int | `4096` | 64-1000000 |
| `RUST_EMBED_PROVIDER_URL` | string | - | Required for provider mode |
| `RUST_EMBED_PROVIDER_API_KEY` | string | - | Provider auth |
| `RUST_EMBED_PROVIDER_MODEL` | string | - | Embedding model ID |
| `RUST_EMBED_PROVIDER_TIMEOUT_MS` | int | `8000` | 100-60000 |

## Security/runtime policy (from `.env.example`)

| Variable | Notes |
|---|---|
| `MEMPHIS_API_TOKEN` | Mandatory in production safety checks |
| `MEMPHIS_VAULT_PEPPER` | Required when vault endpoints are used |
| `MEMPHIS_VAULT_ENTRIES_PATH` | Vault entries file path |
| `GATEWAY_EXEC_RESTRICTED_MODE` | Restricts gateway `/exec` commands |
| `GATEWAY_EXEC_ALLOWLIST` | Allowed commands list |
| `GATEWAY_EXEC_BLOCKED_TOKENS` | Blocked shell token list |

---

## 4) Config structure and profile behavior

At startup, Memphis performs:
1. Parse and validate env with `zod` schema
2. Apply profile policy (`development` / `test` / `production`)
3. Enforce production safety guards

### Production profile behavior

In production, Memphis enforces stricter defaults:
- `LOG_LEVEL=debug` is normalized to `info`
- `GEN_TIMEOUT_MS` capped at `20000`
- `GEN_MAX_TOKENS` capped at `1024`
- `MEMPHIS_API_TOKEN` must be present
- Provider credentials must exist for selected default provider

---

## 5) Provider configuration examples

## Local-only baseline

```dotenv
DEFAULT_PROVIDER=local-fallback
LOCAL_FALLBACK_ENABLED=true
```

## Shared LLM provider

```dotenv
DEFAULT_PROVIDER=shared-llm
SHARED_LLM_API_BASE=https://api.example.com/v1
SHARED_LLM_API_KEY=replace-me
```

## Decentralized provider

```dotenv
DEFAULT_PROVIDER=decentralized-llm
DECENTRALIZED_LLM_API_BASE=https://api.example.com/v1
DECENTRALIZED_LLM_API_KEY=replace-me
```

Verify provider readiness:

```bash
npm run -s cli -- providers:health
npm run -s cli -- providers list
npm run -s cli -- models list
```

---

## 6) Security settings (recommended)

- Never commit `.env` containing real secrets
- Set `NODE_ENV=production` only with complete tokens/keys
- Keep `GATEWAY_EXEC_RESTRICTED_MODE=true` unless explicitly required
- Define strict command allowlist for gateway exec
- Rotate provider API keys periodically
- Restrict file permissions for runtime secrets:

```bash
chmod 600 .env
```

Cross-reference: [SECURITY.md](../SECURITY.md), [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

---

## 7) Performance tuning

Start conservative, then tune with measurements.

## Primary knobs

- `GEN_TIMEOUT_MS`: lower for strict latency, higher for slow providers
- `GEN_MAX_TOKENS`: lower for cost/latency control
- `RUST_EMBED_MAX_TEXT_BYTES`: lower to protect embedding latency
- `RUST_EMBED_PROVIDER_TIMEOUT_MS`: tune for remote embedding API SLA

## Practical tuning sequence

1. Baseline with defaults
2. Run:

```bash
npm run -s cli -- health --json
npm run -s bench:run
```

3. Change one variable at a time
4. Re-check latency and error rates
5. Record stable profile per environment

---

## 8) Validation and diagnostics

```bash
npm run -s cli -- doctor --json
npm run -s cli -- health --json
npm run build
npm test
```

If configuration fails validation, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md#configuration-errors).
