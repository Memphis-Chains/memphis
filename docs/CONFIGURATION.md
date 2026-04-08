# Memphis Configuration Guide

![Config](https://img.shields.io/badge/config-.env%20%2B%20schema-informational)
![Security](https://img.shields.io/badge/security-production%20checks-critical)

This guide explains runtime configuration for Memphis on Ubuntu/WSL.

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
npm run bootstrap
npm run -s cli -- init
```

`bootstrap` creates `.env`, build artifacts, runtime secrets, and service wiring.
`memphis init` is the controlled operator-first step that initializes the vault
and first meaningful chains.

Recommended safe development baseline if you prefer to edit `.env` manually:

```dotenv
NODE_ENV=development
HOST=127.0.0.1
PORT=3000
MCP_PORT=3001
LOG_LEVEL=info
LOG_FORMAT=text

DEFAULT_PROVIDER=ollama
OLLAMA_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5-coder:3b
LOCAL_FALLBACK_ENABLED=true

DATABASE_URL=file:./data/memphis.db
RUST_CHAIN_ENABLED=true
```

Validate:

```bash
npm run -s cli -- doctor --json
```

---

## 3) Environment variables (`.env`)

## Localhost defaults

- Memphis runtime/API: `127.0.0.1:3000`
- Optional external MCP over HTTP: `127.0.0.1:3001`
- CLI and TUI do not connect through HTTP MCP by default; they call the same tool/runtime handlers in-process.

## Core runtime

| Variable     | Type   | Default       | Notes                               |
| ------------ | ------ | ------------- | ----------------------------------- |
| `NODE_ENV`   | enum   | `development` | `development`, `test`, `production` |
| `HOST`       | string | `127.0.0.1`   | API bind host                       |
| `PORT`       | int    | `3000`        | 1-65535                             |
| `MCP_PORT`   | int    | `3001`        | External MCP-over-HTTP bind port    |
| `LOG_LEVEL`  | enum   | `info`        | `debug`, `info`, `warn`, `error`    |
| `LOG_FORMAT` | enum   | `text`        | `text` or `json`                    |

## Provider and generation

| Variable                     | Type   | Default                  | Notes                                                                                       |
| ---------------------------- | ------ | ------------------------ | ------------------------------------------------------------------------------------------- |
| `DEFAULT_PROVIDER`           | enum   | `ollama`                 | `ollama`, `glm`, `deepseek`, `minimax`, `shared-llm`, `decentralized-llm`, `local-fallback` |
| `OLLAMA_URL`                 | string | `http://127.0.0.1:11434` | Ollama base URL                                                                             |
| `OLLAMA_MODEL`               | string | `qwen2.5-coder:3b`       | Default Ollama model                                                                        |
| `SHARED_LLM_API_BASE`        | string | -                        | Required if `DEFAULT_PROVIDER=shared-llm`                                                   |
| `SHARED_LLM_API_KEY`         | string | -                        | Required if `DEFAULT_PROVIDER=shared-llm`                                                   |
| `DECENTRALIZED_LLM_API_BASE` | string | -                        | Required if `DEFAULT_PROVIDER=decentralized-llm`                                            |
| `DECENTRALIZED_LLM_API_KEY`  | string | -                        | Required if `DEFAULT_PROVIDER=decentralized-llm`                                            |
| `LOCAL_FALLBACK_ENABLED`     | bool   | `true`                   | Local fallback provider toggle                                                              |
| `GEN_TIMEOUT_MS`             | int    | `30000`                  | 100-120000                                                                                  |
| `GEN_MAX_TOKENS`             | int    | `512`                    | 1-32768                                                                                     |
| `GEN_TEMPERATURE`            | float  | `0.4`                    | 0.0-2.0                                                                                     |
| `GLM_API_KEY`                | string | -                        | Zhipu AI key — adds GLM as provider priority 4                                              |
| `GLM_MODEL`                  | string | -                        | GLM model name                                                                              |
| `DEEPSEEK_API_KEY`           | string | -                        | DeepSeek key — adds deepseek as provider priority 2                                         |
| `DEEPSEEK_MODEL`             | string | `deepseek-chat`          | DeepSeek model                                                                              |
| `MINIMAX_API_KEY`            | string | -                        | MiniMax key — adds minimax as provider priority 3                                           |
| `MINIMAX_MODEL`              | string | `MiniMax-M2`             | MiniMax model                                                                               |

## Storage and chain bridge

| Variable                        | Type   | Default                  | Notes                                            |
| ------------------------------- | ------ | ------------------------ | ------------------------------------------------ |
| `DATABASE_URL`                  | string | `file:./data/memphis.db` | SQLite URL                                       |
| `RUST_CHAIN_ENABLED`            | bool   | `true`                   | Enables Rust chain bridge path                   |
| `RUST_CHAIN_BRIDGE_PATH`        | string | `./crates/memphis-napi`  | Bridge location                                  |
| `RUST_CHAIN_REQUIRE_SIGNATURES` | bool   | `false`                  | Enforces block signatures during Rust validation |
| `RUST_CHAIN_SIGNER_KEY_HEX`     | string | -                        | 32-byte hex private key for auto-sign on append  |

## Embeddings runtime

| Variable                         | Type   | Default | Notes                                                                                                             |
| -------------------------------- | ------ | ------- | ----------------------------------------------------------------------------------------------------------------- |
| `RUST_EMBED_MODE`                | enum   | `local` | `local`, `ollama`, `openai-compatible`, `cohere`, `voyage`, `jina`, `mistral`, `together`, `nvidia`, `mixedbread` |
| `RUST_EMBED_DIM`                 | int    | `32`    | 1-4096; auto-truncated/padded for network providers                                                               |
| `RUST_EMBED_MAX_TEXT_BYTES`      | int    | `4096`  | 64-1000000                                                                                                        |
| `RUST_EMBED_PROVIDER_URL`        | string | -       | Required for `openai-compatible` and other network modes                                                          |
| `RUST_EMBED_PROVIDER_API_KEY`    | string | -       | Provider auth                                                                                                     |
| `RUST_EMBED_PROVIDER_MODEL`      | string | -       | Embedding model ID                                                                                                |
| `RUST_EMBED_PROVIDER_TIMEOUT_MS` | int    | `8000`  | 100-60000                                                                                                         |

## Security/runtime policy (from `.env.example`)

| Variable                            | Notes                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `MEMPHIS_API_TOKEN`                 | Mandatory in production safety checks                                  |
| `MEMPHIS_VAULT_PEPPER`              | Required when vault endpoints are used (min 12 chars)                  |
| `MEMPHIS_CHANNEL_GATEWAY_ENABLED`   | Opt-in toggle for Telegram channel gateway                             |
| `MEMPHIS_TELEGRAM_BOT_TOKEN`        | Telegram bot token when channel gateway is enabled                     |
| `MEMPHIS_TELEGRAM_ALLOWED_USER_IDS` | Comma-separated Telegram user IDs allowlist (optional)                 |
| `MEMPHIS_TELEGRAM_TOKEN_OVERRIDE`   | Override bot token (optional)                                          |
| `MEMPHIS_MATRIX_ENABLED`            | Enables bounded trusted-pilot Matrix readiness checks                  |
| `MEMPHIS_MATRIX_HOMESERVER`         | Matrix homeserver URL for the pilot path                               |
| `MEMPHIS_MATRIX_ACCESS_TOKEN`       | Matrix access token; may be set as `VAULT:MEMPHIS_MATRIX_ACCESS_TOKEN` |
| `MEMPHIS_MATRIX_ADMIN_USER`         | Matrix admin user name used for pilot/bootstrap status                 |
| `MEMPHIS_MATRIX_SERVER_NAME`        | Matrix server name emitted by `setup matrix`                           |
| `MEMPHIS_MATRIX_TRUST_MODE`         | `trusted-pilot` by default; `public-deferred` remains non-GA           |
| `MEMPHIS_VAULT_ENTRIES_PATH`        | Vault entries file path                                                |
| `GATEWAY_EXEC_RESTRICTED_MODE`      | Restricts gateway `/exec` commands                                     |
| `GATEWAY_EXEC_ALLOWLIST`            | Allowed commands list                                                  |
| `GATEWAY_EXEC_BLOCKED_TOKENS`       | Blocked shell token list                                               |
| `MEMPHIS_MODEL_D_AGENT_ID`          | Optional local agent id for Model D receiver routing                   |
| `MEMPHIS_MODEL_D_AGENT_NAME`        | Optional display name in Model D vote response                         |
| `MEMPHIS_SAFE_MODE`                 | Disables generation endpoints (403) when `true`                        |
| `MEMPHIS_STRICT_MODE`               | Enables strict runtime validation                                      |
| `MEMPHIS_FAULT_INJECT`              | Fault injection mode for chaos testing                                 |
| `MEMPHIS_AGENT_NAME`                | Agent display name (default: "Memphis Agent")                          |
| `MEMPHIS_OWNER_NAME`                | Owner display name (default: "local operator")                         |

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
- Prefer `VAULT:` references for secrets that Memphis resolves at runtime, including `MEMPHIS_MATRIX_ACCESS_TOKEN`
- Define strict command allowlist for gateway exec
- Rotate provider API keys periodically
- Restrict file permissions for runtime secrets:

```bash
chmod 600 .env
```

Cross-reference: [SECURITY.md](../SECURITY.md), [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

---

## Operational thresholds

| Variable                                 | Type   | Default     | Notes                                           |
| ---------------------------------------- | ------ | ----------- | ----------------------------------------------- |
| `MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES` | int    | —           | Chain rotation byte threshold (1MiB–1GiB)       |
| `MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS` | int    | —           | Min blocks to keep during rotation              |
| `MEMPHIS_SNAPSHOT_MAX_AGE_MS`            | int    | —           | Snapshot max age (1h–30d)                       |
| `MEMPHIS_SNAPSHOT_MIN_KEEP`              | int    | —           | Min snapshots to retain                         |
| `MEMPHIS_HEARTBEAT_INTERVAL_MS`          | int    | —           | Heartbeat interval (5s–1h)                      |
| `MEMPHIS_MEMORY_WARN_THRESHOLD`          | float  | —           | Memory usage warning threshold (0.5–0.99)       |
| `MEMPHIS_FEATURES`                       | string | —           | Comma/space-separated preview flags such as `experimental-tools` |
| `MEMPHIS_REFLECTION_ENABLED`             | bool   | `true`      | Enable reflection subsystem                     |
| `MEMPHIS_REFLECTION_INTERVAL_MS`         | int    | —           | Reflection interval (min 1h)                    |
| `MEMPHIS_RATE_LIMIT_GLOBAL_MAX`          | int    | —           | Global rate limit max                           |
| `MEMPHIS_RATE_LIMIT_SENSITIVE_MAX`       | int    | —           | Sensitive route rate limit max                  |
| `MEMPHIS_QUEUE_MODE`                     | enum   | `financial` | `financial` (WAL + replay) or `standard`        |
| `MEMPHIS_QUEUE_RESUME_POLICY`            | enum   | `keep`      | WAL resume policy: `keep`, `fail`, `redispatch` |
| `MEMPHIS_QUEUE_WAL_PATH`                 | string | —           | Custom WAL file path                            |
| `MEMPHIS_QUEUE_WAL_MAX_BYTES`            | int    | `10485760`  | WAL max size (1MiB–1GiB)                        |
| `MEMPHIS_MAX_PENDING_TASKS`              | int    | `100`       | Max pending tasks in queue                      |

---

## Feature flags

Stable Memphis behavior is the default. Preview surfaces are opt-in:

```dotenv
MEMPHIS_FEATURES=experimental-tools
```

Current aliases accepted by the runtime include `experimental` and `labs`.
With `experimental-tools` enabled, preview MCP/runtime tools such as
`memphis_chain_query`, `memphis_providers`, and `memphis_system_info`
become visible to the registry, operator guide, manifest, and MCP server.

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
