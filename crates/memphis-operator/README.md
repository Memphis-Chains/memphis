# memphis-operator

Native Rust operator console — chat runtime + provider adapters + config. Replaces the legacy TypeScript TUI as the active operator surface (per `docs/ROADMAP-CURRENT.md` M1).

## Public surface

- `chat.rs` — chat loop (streaming, tool dispatch, approval gates)
- `config.rs` — runtime config resolver (vault-first secret resolution)
- `provider.rs` — provider adapters (Ollama, Anthropic, MiniMax, GLM, DeepSeek, OpenAI)
- `runtime.rs` — top-level runtime orchestration

## Build

```bash
cargo build -p memphis-operator
cargo test -p memphis-operator --lib
```

## Layer

L5 surface (operator console). Used by `memphis-tui` as the native chat backend; also dispatched via `memphis-napi` so the TS gateway can use the same provider cascade.

## Provider cascade

Default order: `local-fallback` → `ollama` → operator-configured remote. Each provider implements the same trait (`provider.rs`). Cost-cap, circuit-breaker, and tier-gates apply uniformly across providers.

`sanitize_for_json()` (post-v1.2.3 fix) handles invalid `\xNN` escapes that DeepSeek's API rejected — applied before every outbound request.
