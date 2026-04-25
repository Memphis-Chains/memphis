# Codex Readiness - 2026-04-20

source: codex
topic: agent-readiness

## Role

Codex is prepared to work on the local `memphis` repository as an implementation
agent, using local-first, reversible edits and preserving existing user changes.

## Repo Baseline

- Package: `@memphis-chains/memphis` v1.4.0.
- Runtime stack: TypeScript ESM orchestration plus Rust workspace crates.
- Main TypeScript areas:
  - `src/infra/cli/`
  - `src/infra/http/`
  - `src/modules/orchestration/`
  - `src/providers/`
  - `src/gateway/`
  - `src/mcp/`
  - `src/infra/storage/`
- Rust crates:
  - `crates/memphis-core`
  - `crates/memphis-vault`
  - `crates/memphis-embed`
  - `crates/memphis-napi`
  - `crates/memphis-tui`
  - `crates/memphis-operator`
  - `crates/memphis-case-index`

## Working Rules

- Do not commit or print secrets. Treat `.env`, `_Watra/agent-credentials.json`,
  vault files, and tokens as local-only sensitive material.
- Keep changes small and module-aligned.
- Preserve existing worktree changes. Current pre-existing change observed:
  `crates/memphis-napi/index.node` binary differs from git.
- Prefer project patterns over new abstractions.
- For user-visible behavior changes, update docs and changelog when appropriate.

## Quality Gates

Project docs expect these gates before PR-quality delivery:

```bash
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npm run test:rust
```

Targeted checks should be used first during small changes, then broader gates as
risk increases.

## Local Environment Status

Available in the current Codex execution environment:

- Python 3
- Git
- Rust toolchain commands: `cargo`, `rustc`
- Local repo dependencies in `node_modules/`

Blocked or missing in the current Codex execution environment:

- `node` and `npm` are not in PATH, so TypeScript build/test commands cannot run.
- `cc`, `gcc`, and `clang` are not in PATH, so `cargo test --workspace` fails at
  dependency build-link time.
- `curl`, `wget`, `docker`, and `apt-get` are not in PATH inside this snap-based
  Codex environment.
- Synjar API at `http://localhost:6200/health` returned connection refused during
  setup, so agent-note inbox reads are unavailable until Synjar is started.

Observed failure:

```text
cargo test --workspace
error: linker `cc` not found
```

## Synjar

Workspace IDs are available in `/home/memphis/_Watra/workspaces.json`.
Do not print or commit credentials from `/home/memphis/_Watra/agent-credentials.json`.

If Synjar is running, Codex should check `agent-notes` for open `to:codex` notes
at task start and write handoff notes there when useful.
