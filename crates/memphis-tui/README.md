# memphis-tui

Native ratatui-based terminal cockpit. The active operator console (replaces the legacy TypeScript TUI archived under `docs/archive/`).

## Public surface

`cargo run -p memphis-tui` (or via the CLI: `memphis tui`).

Tabs: Overview · Chat · Memory · Sessions · Vault · Cases · System.

Status bar shows: cognitive mode (A-E), provider/model, PULSE health, session id.

## Build

```bash
cargo build -p memphis-tui
cargo run -p memphis-tui
```

For check-only smoke (used by CI):

```bash
memphis tui --check-only --json
```

## Layer

L5 surface. Talks to `memphis-operator` (chat backend) and `memphis-napi` bridge (chain/vault ops). No business logic — pure renderer + input dispatcher.

## Reference docs

- Migration history from TS TUI: `docs/dev/TUI-RATATUI-MIGRATION-SEAM.md`
- Operator usage: `docs/operator/TUI-OPERATOR-GUIDE.md`
