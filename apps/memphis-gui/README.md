# Memphis Desktop — Tauri shell (Phase G-minimal MVP)

> ADR-aligned scaffold for the Memphis Desktop surface. Side-by-side
> with `crates/memphis-tui/` (ratatui / TTY). Same backend
> (`memphis-operator` + `memphis-core`), different presentation
> layer (Tauri 2 + WebView vs ratatui + crossterm).

## What's here today (2026-09-21)

- `src-tauri/Cargo.toml` — Tauri 2 crate with path-deps to `memphis-operator`
  and `memphis-core`, so the contract lives in a single workspace.
- `src-tauri/src/lib.rs` — one Tauri command: `memphis_get_snapshot`.
  Returns a stub `MemphisSnapshot` so the Tauri ↔ WebView IPC surface
  can be validated end-to-end without booting the full memphis stack.
- `src-tauri/src/runtime_stub.rs` — fixed-shape snapshot builder.
- `src-tauri/src/main.rs` — entry point that calls `memphis_gui_lib::run()`.
- `src-tauri/tauri.conf.json` — minimal Tauri config; bundle disabled
  (operator uses systemd + TTY-rust-tui for headless boxes; the Tauri
  shell is opt-in for desktop parity).
- `index.html` + `dist/main.js` + `dist/styles.css` — vanilla JS frontend
  that invokes `memphis_get_snapshot` and renders the JSON result.

## What's NOT here today

- **Real `memphis_operator::OperatorRuntime`** wired into a `tauri::State`.
  Phase G-mid swaps the stub body to `state.runtime.snapshot()` against
  `OperatorRuntime::new()` seeded from the operator's local state dir.
- **React + shadcn/ui**. Phase G-minimal deliberately ships vanilla JS
  to minimise the dependency surface; Phase G-mid swaps in the framework
  per the roadmap's Tauri + React + shadcn default.
- **Multiple commands** (Phase G-mid). Today only `memphis_get_snapshot`.
  Phase G-mid adds `memphis_chat_send`, `memphis_status_bar`, and
  `memphis_open_settings_dialog`.
- **Bundle** (`.deb` / `.msi` / `.dmg`). Disabled in `tauri.conf.json`
  because operator machines ship via systemd, not a packaged desktop.
  Enable per `cargo tauri build --target x86_64-unknown-linux-gnu`
  when a packaged Desktop distribution becomes a real demand.

## Run

```bash
# From the monorepo root.
cd apps/memphis-gui/src-tauri
cargo run                                    # debug build
cargo run --release                          # release build

# OR workspace-wide
cargo build -p memphis-gui --release
```

The window opens with the Memphis header, a "Snapshot" panel showing
the stub JSON, and a "Refresh snapshot" button.

## Capability allowlist

The `tauri.conf.json` allowlist is intentionally bare. Phase G-mid
narrows further via `tauri::generate_context!` + `capabilities/*.json`.
WebView `fetch()` to the host HTTP gateway is NOT exposed — every
state read goes through a Tauri command, mirroring the chain
invariant surface (`memphis_get_snapshot` can be the only path the
WebView uses to read state in the first week of Phase G-minimal).

## Coordination with `crates/memphis-tui/`

- Same backend (`memphis-operator` + `memphis-core`).
- No state duplication. The runtime is the host; both UIs read it.
- Snapshot shape (`OperatorSnapshot`) is the source-of-truth interface.
  Phase G-mid switches the stub body in this crate to return the
  real type from `memphis_operator::OperatorSnapshot::from_runtime(...)`.

## Out-of-scope for this scaffold

- System tray (Phase G-mid).
- File dialogs (Phase G-mid).
- Multi-window manager (Phase G-mid).
- Cross-platform packaging (Phase G-mid / Phase G-full).
- Native menubar (Phase G-full).

Phase G-minimal scope is intentionally small: prove the Tauri ↔
WebView ↔ backend IPC contract. Everything else is iteration.
