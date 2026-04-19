# On-the-fly configuration

Sprint 6 adds three coordinated paths for changing Memphis configuration
without restarting the process:

- **HTTP**: `GET /v1/ops/config/show`, `POST /v1/ops/config/set`,
  `POST /v1/ops/config/reload`
- **TUI host**: capabilities `config.show`, `config.set`, `config.reload`
- **Telegram**: `/config show`, `/config set KEY=VALUE`, `/config reload`

All three rely on the same engine in `src/infra/config/hot-reload.ts` so
behavior is identical across surfaces.

## Field mutability taxonomy

`src/infra/config/mutability.ts` classifies every env key known to
`envSchema` into one of four tiers:

| Tier     | Behavior                                                                    | Examples                                                                                      |
| -------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `hot`    | Swap at runtime, read fresh on each use                                     | `GEN_TIMEOUT_MS`, `GEN_MAX_TOKENS`, `GEN_TEMPERATURE`, `OLLAMA_*`, `MEMPHIS_PROVIDER_CASCADE` |
| `warm`   | Swap at runtime; subsystem may still see cached value until its own re-init | `LOG_LEVEL`, `DEFAULT_PROVIDER`, `MEMPHIS_RATE_LIMIT_*`, `RUST_EMBED_PROVIDER_*`              |
| `cold`   | Restart required — never swapped at runtime                                 | `PORT`, `HOST`, `MCP_PORT`, `DATABASE_URL`, `RUST_CHAIN_BRIDGE_PATH`                          |
| `secret` | Tier-3 elevation required; values are redacted in all output                | `*_API_KEY`, `MEMPHIS_VAULT_PEPPER`, `MEMPHIS_API_TOKEN`, `MEMPHIS_TELEGRAM_BOT_TOKEN`        |

Unknown keys fall back to `warm` — the safer of the two ambiguous options.

## Hot reload flow

1. `performHotReload()` reads the current `.env` file via
   `resolveDotEnvPath()` and parses it with the same conventions as
   `setDotEnvValues`.
2. Each key in the file is diffed against `process.env`; classified;
   either accepted (`applied`), passed-through (`unchanged`), refused
   (`rejected-cold`), or flagged (`invalid`) when validation against
   `envSchema` fails.
3. If any cold field is changing or any value fails schema validation,
   the engine returns `ok: false` and **does not** mutate `process.env`.
4. On success, `process.env` is updated in place. The diff is returned to
   the caller — secret values are always redacted.

## Surface behavior

### HTTP

```
POST /v1/ops/config/reload
  → 200 { ok: true, result: { changes: [...], appliedCount, unchangedCount } }
  → 409 { ok: false, error: "...", coldFields: [...], result: {...} }
  → 400 { ok: false, error: "<schema validation error>", result: {...} }

POST /v1/ops/config/set
Body: { "key": "GEN_MAX_TOKENS", "value": "4096" }
  → 200 { ok: true, key, tier, newValue }
  → 409 (cold field)
  → 403 (secret field)
  → 400 (validation error)
```

All three endpoints write `config.set` / `config.reload` security audit
events. Secrets never appear in audit `details`.

### TUI host

The capabilities expect args `{ key?, value? }`:

- `config.show` (optional `key`) — returns the redacted view.
- `config.set` (`key`, `value`) — refuses cold and (without tier-3)
  secret fields. Throws an error visible to the caller.
- `config.reload` — same outcome as the HTTP endpoint.

### Telegram

The `/config` command is gated to tier 2; secret fields additionally
require tier 3 via `/tier 3 <passphrase>`. Cold fields are refused with a
clear message — never silently dropped.

```
/config show                    — list all known fields (truncated at 60)
/config show GEN_MAX_TOKENS     — single field
/config set GEN_MAX_TOKENS=4096
/config reload
```

## Known limitations

The taxonomy reflects the **observable** behavior of each field today.
A field marked `warm` indicates the value is owned by a module that may
still hold a cached copy until its next re-init. The hot-reload engine
makes the new value visible in `process.env` immediately; downstream
consumers that need a kick (rate limiter singletons, structured loggers)
remain follow-up work.

## Post-apply hooks

Subsystems that own cached env values can register a post-apply hook
keyed by env name (`src/infra/config/post-apply-hooks.ts`). When a
`/config reload` swaps that env, the hook fires with the old/new
values and a `process.env` snapshot. Hook errors are caught and
reported in the reload result; a failing hook never aborts the swap.

Wired today:

| Env key            | Hook                               | What it does                                                                                                                                                       |
| ------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DEFAULT_PROVIDER` | `orchestration.setDefaultProvider` | Validates the new name against the registered provider list and updates the `OrchestrationService` cached default so the very next turn lands on the new provider. |

`MEMPHIS_PROVIDER_CASCADE` doesn't need a hook — the cascade list is
already re-read per request inside `OrchestrationService`.

Rate-limit singletons and per-instance loggers are the next two
candidates for hooks; they remain follow-up work.
