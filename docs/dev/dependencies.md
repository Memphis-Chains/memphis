# Dependencies (exhaustive)

Surfaced by the production-1st-install sprint (2026-04-19) — every dependency Memphis pulls onto a clean PC, with rationale.

## System packages (auto-installed by `scripts/install.sh`)

| Package                                                                                                                      | Why                                                             | Install path                   |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------ |
| `git`                                                                                                                        | Repo clone + version pinning                                    | apt/dnf/yum/pacman/zypper/brew |
| `curl` (or `wget` or `python3`)                                                                                              | Downloader for installer scripts (NodeSource, rustup, ollama)   | apt/dnf/yum/pacman/zypper/brew |
| `build-essential` (apt) / `Development Tools` (dnf/yum) / `base-devel` (pacman) / `devel_C_C++` (zypper) / Xcode CLT (macOS) | C/C++ toolchain for `better-sqlite3` + NAPI bridge native build | distro package manager         |
| `pkg-config` / `pkgconf`                                                                                                     | Library discovery for native builds                             | distro package manager         |
| `libssl-dev` (apt) / `openssl-devel` (dnf/yum) / `openssl` (brew/pacman) / `libopenssl-devel` (zypper)                       | OpenSSL headers for crypto-bearing native modules               | distro package manager         |
| `python3`                                                                                                                    | Required by `node-gyp` for native module builds                 | distro package manager         |
| `sudo`                                                                                                                       | System package install (auto-skipped if running as root)        | system                         |

**Memphis does not install:** systemd (used as system service if present, but the runtime works without it via `memphis service stop` + manual `memphis serve`).

## Runtime: Node.js v22+

Source: NodeSource (`setup_22.x` script) on Linux; Homebrew (`node@22`) on macOS.

Why v22: ESM + native fetch + permission model. `package.json` declares `"engines": { "node": ">=22" }` and CI fails on lower versions.

## Runtime: Rust stable

Source: rustup (`https://sh.rustup.rs`).

Why stable: `crates/` workspace targets stable. Phase A3 sanitizers (PR #163) use nightly but only in CI, not for everyday builds.

Required components: `rustc`, `cargo`, `rustfmt` (for `cargo fmt`), `clippy` (for lint gate). The installer pulls `rustfmt` automatically; `clippy` may need explicit install on systems where it wasn't auto-bundled (`rustup component add clippy`).

## Runtime: Ollama (optional but recommended)

Source: `https://ollama.com/install.sh`.

Why optional: Memphis has a `local-fallback` provider that returns minimal echo responses without a real LLM, so the runtime is operational even without Ollama. Real chat needs either Ollama (local) or a remote provider (Anthropic/OpenAI/MiniMax/GLM/DeepSeek with vault-stored API key).

Default models pulled by installer:

- `nomic-embed-text` — embeddings (137M params, ~85 MB)
- `cogito:3b` — chat (~2 GB)

The sovereign-RAG proof (2026-04-19) used `all-minilm` (22M params, ~23 MB) instead — runs on Intel i3-2120 without timing out. Configure with `RUST_EMBED_PROVIDER_URL=http://127.0.0.1:11434` and `MEMPHIS_EMBED_MODEL=all-minilm` to use the smaller model.

## npm dependencies (production)

Captured from `package.json` at v1.3.0. Listed by category, not alphabetically.

### HTTP + transport

- `fastify` — gateway HTTP server
- `hono` + `@hono/node-server` — secondary HTTP layer (dashboards, MCP HTTP transport)
- `pino` + `pino-pretty` — structured logging

### Storage

- `better-sqlite3` — SQLite native bindings (exact-search FTS5 + KV)
- `@memphis-chains/memphis` (self) — npm package metadata

### Provider SDKs

- `@anthropic-ai/sdk` — Anthropic provider (native + OAuth)
- `openai` — used for OpenAI-compatible endpoints (DeepSeek/Z.AI etc reuse this client shape)
- `ollama` — Ollama HTTP client

### Telegram

- `node-telegram-bot-api` — Telegram bot SDK
- `discord.js` — Discord (gated; v13 — see below)

### Validation + types

- `zod` — schema validation (config, MCP tool inputs, surface inputs)

### MCP

- `@modelcontextprotocol/sdk` — MCP server + client
- `eventsource` — SSE transport

### Voice (optional)

- `@google-cloud/text-to-speech` — TTS fallback for Telegram voice messages

### OpenTelemetry (opt-in)

- `@opentelemetry/api` + `@opentelemetry/sdk-node` + `@opentelemetry/exporter-trace-otlp-http` + `@opentelemetry/resources` + `@opentelemetry/semantic-conventions` — OTel tracing (no-op when `MEMPHIS_OTEL_ENDPOINT` unset)

### Misc runtime

- `dotenv` — `.env` file loading (vault-first; .env is fallback)
- `tsx` — TypeScript runner (used by `npm run dev` and `bin/memphis.js`)

## npm dependencies (dev)

- `vitest` — test runner (4.x)
- `eslint` + `typescript-eslint` + `@eslint/js` — lint
- `prettier` — formatter (referenced by nightly-crystal Format-check gate)
- `typescript` — TS compiler (5.x; v6 bump deferred)
- `typedoc` — API doc generation
- `@types/*` — type stubs

## Cargo workspace dependencies

`Cargo.toml` workspace deps (non-exhaustive — see `Cargo.lock` for full graph):

- **memphis-vault:** `argon2`, `aes-gcm`, `ed25519-dalek`, `hkdf`, `sha2`, `zeroize`, `serde`, `serde_json`, `hex`
- **memphis-core:** `sha2`, `ed25519-dalek`, `serde`, `serde_json`
- **memphis-embed:** `tokio` (HTTP client), `serde`, `reqwest`, `ort` (planned for ONNX local provider — M6)
- **memphis-napi:** `napi`, `napi-derive`, `napi-build`, `tokio`
- **memphis-operator:** `tokio`, `reqwest`, `serde`, `serde_json`, `ratatui` (TUI deps shared)
- **memphis-tui:** `ratatui`, `crossterm`, `tokio`
- **memphis-case-index:** `rusqlite`, `serde`, `serde_json`

## Outdated bumps available (informational)

As of `npm outdated` on 2026-04-19:

### Safe minor / patch (no breaking changes expected)

- `@types/node` 25.5.2 → 25.6.0
- `@opentelemetry/resources` 2.6.1 → 2.7.0
- `better-sqlite3` 12.8.0 → 12.9.0
- `dotenv` 17.4.1 → 17.4.2
- `prettier` 3.8.1 → 3.8.3
- `typedoc` 0.28.18 → 0.28.19
- `typescript-eslint` 8.58.0 → 8.58.2
- `vitest` 4.1.2 → 4.1.4

### Major bumps (each requires its own review)

- `@anthropic-ai/sdk` 0.78.0 → 0.90.0
- `discord.js` 13.x → 14.x (breaking — major API rewrite)
- `typescript` 5.9.3 → 6.0.3
- `eslint` 9.x → 10.x
- `ollama` 0.5.x → 0.6.x

The minor bumps are safe to do as a single dependency-bump PR; major bumps each warrant their own PR with target test runs.

## Disk + memory footprint

After a clean install (no chains, no vault entries):

- `~/memphis/` (repo + node_modules + cargo target + dist) — ~1.7 GB
- `~/.memphis/` (state, empty) — ~50 KB
- Ollama models (cogito:3b + nomic-embed-text) — ~2.1 GB

**Memory at idle:** ~150 MB (Node daemon) + ~250 MB (Rust operator) = ~400 MB. With Ollama warm + cogito:3b loaded: ~2.5 GB total.

**Memory under chat load:** add ~500 MB per concurrent turn (transient).

## Verification

```bash
# What's installed?
node --version            # ≥ v22
rustc --version           # stable
cargo --version
ollama --version          # optional

# What's in the repo?
ls node_modules/ | wc -l  # ~700+ packages
du -sh node_modules/      # ~300 MB
du -sh target/            # ~250 MB after build
du -sh dist/              # ~30 MB after build

# What's running?
memphis service status
ollama ps                 # if Ollama installed
```

---

_Last verified: 2026-04-19 against scripts/install.sh, package.json v1.3.0, and Cargo.lock as of `40b546c`._
