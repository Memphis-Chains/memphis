# CLI API

## Command Surface
- `health` — Local runtime health check.
- `providers:health` — Provider connectivity/health report.
- `providers list` — Configured providers.
- `models list` — Available models + capabilities.
- `chat` — Single-shot generation.
- `ask` — Session-aware generation with context memory.
- `decide history|transition` — Decision lifecycle history and transitions.
- `infer` — Infer decision signal from text.
- `mcp serve|serve-once|serve-status|serve-stop` — Native MCP transport lifecycle.
- `onboarding wizard|bootstrap` — Interactive/env bootstrap flows.
- `chain import_json` — Import chain blocks from JSON payload.
- `vault init|add|get|list` — Vault key/value lifecycle.
- `embed store|search|reset` — Embedding store and semantic search.
- `completion <bash|zsh|fish>` — Shell completion script generation.
- `doctor` — Runtime readiness checks.
- `tui` — Interactive terminal UI.

## Global Flags
- `--json` structured output
- `--provider`, `--model`, `--strategy` generation routing
- `--interactive`/`--tui` terminal UX

## Error Codes
See [../core/errors.md](../core/errors.md).
