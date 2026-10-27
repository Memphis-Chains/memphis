# ADR-011 — Cockpit Core: one brain, two shells (Ratatui TUI + Tauri GUI)

Date: 2026-10-26
Status: Proposed
Deciders: operator (Wodzu)
Related: ADR-010 (Tauri build status), `MEMPHIS_ARCHITECTURE_LAYERS.md` (L5 surfaces),
`src/infra/tui-host/` (stdio-JSON host protocol), `crates/memphis-tui/` (Ratatui cockpit)

## Summary

The Memphis operator cockpit is a Ratatui terminal application (`crates/memphis-tui`,
11 198 LOC). A Tauri desktop shell existed once as a 107-line stub and was deleted on
2026-10-06 because it had neither a build path nor a test. This ADR proposes rebuilding
it — but **not as a second implementation**.

The proposal is a three-layer move:

1. **Extract the cockpit brain** into a Ratatui-free library crate, because the brain
   (`app.rs` + `client.rs`, ~8 300 LOC) has **zero Ratatui imports** today. Only the
   renderer (~1 630 LOC) does.
2. **Fix the ergonomics defects that exist in the authoritative cockpit right now** —
   the input caret is never rendered, the prompt is a single row, and there is no
   scrollback search. These cost ~300 LOC and are worth more than any GUI.
3. **Add Tauri as a second shell over the same core**, reusing the existing
   `memphis tui host --stdio-json` protocol that was explicitly designed for GUI consumers.

The ordering is deliberate: the GUI is the expensive, optional part. Layers 1 and 2
deliver value on their own and make the GUI cheap.

---

## Part 1 — What is actually there

### 1.1 The Ratatui cockpit (`crates/memphis-tui`, 11 198 LOC Rust)

| File            | LOC    | Role                                                    | Ratatui? |
| --------------- | ------ | ------------------------------------------------------- | -------- |
| `src/app.rs`    | 7 125  | brain: state, keys, command routing, workers, streaming | **no**   |
| `src/client.rs` | 1 152  | runtime client + extension-host manager                 | **no**   |
| `src/main.rs`   | 881    | event loop, terminal guard, background refresh          | partly   |
| `src/ui.rs`     | 448    | **renderer**: layout + widget composition               | yes      |
| `src/widgets/*` | ~1 180 | **renderer**: body, prompt, status bar, help, toast     | yes      |

Layout (`src/ui.rs:104-140`): optional notification banner → scrollable body →
**1-row** prompt → 1-row status bar; help overlay floats on top.

Seven screens (`Screen::Overview | Chat | Memory | Sessions | Vault | Cases | System`) are
**not** separate views: each renders to a `Vec<StyledLine>` that is appended to one flat
output buffer. There is no interactive list, no paging, no filtering.

The model is **semantic, not presentational**: `LineTone` (`Plain | Title | Header |
Section | Info | Success | Warning | Error | Dim | Accent | Prompt`) is mapped to Ratatui
styles only in `widgets/mod.rs::tone_to_style`. This is the fact that makes a second
shell cheap.

### 1.2 The Tauri ghost

`apps/mephis-gui/` was a 107-line stub: one command `memphis_get_snapshot` returning a
hardcoded `heartbeat_at: "1970-01-01T00:00:00Z"`, a `runtime_stub.rs`, and a
`tauri.conf.json` with `bundle.active = false`. It was removed in commit `0b001ce5`
("chore(repo): wytnij martwe drzewa"). ADR-010 records the two-layer diagnosis: a
manifest path bug (`../../crates/...` from a directory two levels below `apps/`), and
"missing system libraries" on the operator host.

**That second diagnosis was wrong for this host, and the repository still repeats it.**
`Cargo.toml`'s `exclude` comment says Tauri is out of the workspace because
"glib-2.0/gtk/webkit2gtk ... are not present on CI runners **or on the operator host**".
Measured on 2026-10-26:

```
webkit2gtk-4.1                2.54.1   (+ webkit2gtk-web-extension-4.1)
javascriptcoregtk-4.1         2.54.1
libsoup-3.0                   3.8.0
gtk+-3.0                      3.24.52
ayatana-appindicator3-0.1     0.6.1
```

All five Tauri-v2 Linux dependencies are present. The earlier "missing libraries" finding
came from apt/Debian package names (`libayatana-appindicator3-dev`) applied to an Arch
box; the actual pkg-config name here is `ayatana-appindicator3-0.1`. The CI-runner half of
the comment remains true and must stay.

### 1.3 The seam that already exists

`src/infra/tui-host/` is a **versioned NDJSON RPC protocol over stdio**:

- `memphis tui host --stdio-json` — protocol version 1, 37 capabilities
- handshake: `ready` event advertising the capability list
- request: `{type:"execute", id, command, args}` → `started` → `line`\* → `result` | `error` | `cancelled`
- cancel: `{type:"cancel", id}`
- the Rust TUI already speaks it as a client (`ExtensionHostManager` in `client.rs`,
  spawning `tsx src/infra/cli/index.ts tui host --stdio-json`)

The comment at `src/infra/cli/commands/interaction.ts:98` says it outright:
_"tui host is the stdio-json protocol mode used by GUI consumers"_.

**A Tauri GUI is therefore not a from-scratch project. It is a new client of a protocol
that was designed for it, has a contract test (`tests/unit/tui-host.test.ts`), and has
never had a second client.**

---

## Part 2 — Seven findings that change the design

Each finding is stated with the evidence that would falsify it.

### F1 — The brain is already renderer-agnostic

`grep -n "ratatui" crates/memphis-tui/src/app.rs` and the same for `client.rs` return
**nothing**. The 8 277 LOC of state machine, command router, worker orchestration and
stream handling have no terminal dependency at all. Only `ui.rs` + `widgets/` do.

_Consequence:_ a second shell does not require a second brain. It requires a second
renderer. _Falsifier:_ if any of `app.rs`/`client.rs` imports `ratatui` (directly or via
`crate::widgets`), the extraction is not mechanical and must be scoped differently.

### F2 — There are two complete chat stacks, and they differ in ways the operator can feel

|                | Rust stack (`memphis-operator`)           | TS stack (`src/gateway/`)                                 |
| -------------- | ----------------------------------------- | --------------------------------------------------------- |
| used by        | the Ratatui TUI                           | Telegram, CLI `ask`/`chat`                                |
| streaming      | **token-level** (`ChatStreamEvent::Text`) | **none** (`src/providers/index.ts:284` → `stream: false`) |
| tool execution | `chat_tool_executor.rs` (1 398 LOC)       | `tool-executor.ts` + `native-tool-policy.ts`              |
| guards         | `chat_guards.rs`                          | `surface-policy.ts`                                       |

Both write the same table, `operator_chat_messages`, with **complementary column
coverage**: the Rust path fills `tool_calls_json` and leaves `provider`/`model` null; the
TS path fills `provider`/`model` and leaves `tool_calls_json` null. Live counts on
2026-10-26: 7 649 rows / 26 sessions; `provider` populated on 3 139 rows, null on 4 423.

_Consequence:_ a GUI built on the TS host protocol would have **no streaming** — the single
most visible quality of the current cockpit. The GUI must therefore embed the **Rust**
runtime, exactly like the TUI does, and reach the TS stack only for the host commands.

### F3 — The input caret is never rendered

`TerminalGuard::enter()` executes `Hide` (`main.rs:98,105`); `Show` is issued only on
exit (`main.rs:122,127`). `grep -rn "set_cursor_position" crates/ src/` returns **nothing**.
The prompt widget (`widgets/prompt.rs`) renders a single `Paragraph` of one `Line` into a
`Constraint::Length(1)` row.

_Consequence:_ in the authoritative cockpit the operator cannot see where the caret is,
and any prompt longer than the terminal width is silently truncated with no horizontal
scroll. _Falsifier:_ a live session showing a visible block cursor in the prompt.

### F4 — The prompt is one row, and scrollback is unsearchable

`OutputBuffer` is capped at `OUTPUT_BUFFER_LIMIT = 1200` lines. The live database holds
sessions of 1 447, 782 and 737 messages. There is no way to search them: `/sessions`
prints a summary, `Screen::Sessions` renders a summary, and the body is a flat line list
with no find, no paging and no filter.

_Consequence:_ the longest-running sessions — the ones with the most value — are the
least navigable. This is a defect in the _cockpit_, not in a missing GUI.

### F5 — The host protocol cannot host a long operation and a status poll at once

`src/infra/tui-host/index.ts:80-85` rejects any second request while one is in flight:
_"host is busy; only one in-flight request is supported"_.

_Consequence:_ a GUI needs to poll status while a chat streams. The global lock has to
become per-capability. The `Map<String, AbortController>` is already there, so the
change is small — but it is a protocol change (v1 → v2), and the `ready` handshake
already advertises capabilities, so a new client against an old host degrades gracefully.

### F6 — All Tauri system dependencies are present on the operator host

See §1.2. The blocker that killed the first attempt was a package-name mistake, not a
missing capability. _Falsifier:_ `cargo check` on a Tauri v2 crate that depends on
`tauri = "2"` fails with a `glib-sys`/`webkit2gtk` pkg-config error.

### F7 — The frontend framework decision was never made

`review.md:13` lists it as open decision #1 (React+shadcn vs Svelte vs Leptos), raised
2026-05-12 and still open. `ROADMAP_FOR_SORT_BRANCHES.md` locked "React+shadcn/ui", but
nothing was ever built, and `review.md:560` still estimates "Horizon 2 (2-4 tyg)" for it.
The host has 2 cores, 15 GiB RAM and no pnpm/bun.

_Consequence:_ the GUI should not open a frontend-framework debate. The surface is
small, the model is semantic, and the renderer is ~400 LOC of vanilla TypeScript.

---

## Part 3 — The design

### Layer 1 — `crates/memphis-cockpit`: the brain, as a library

New crate `memphis-cockpit` (lib), containing today's `app.rs`, `client.rs`, `config.rs`,
`sanitize.rs`, `error_log.rs` moved verbatim. No Ratatui, no Crossterm. Its public surface:

```rust
pub struct CockpitState { /* today's AppState */ }
pub enum CockpitAction { /* today's AppAction */ }
pub enum CockpitEvent {  /* NEW: what the core emits to any shell */
    Lines(Vec<StyledLine>),   // new output lines (semantic, tone-tagged)
    Chunk(String),           // a streamed chat delta
    Status(StatusBarContext),
    Busy { active: bool, label: Option<String> },
    Degraded(Option<DegradationState>),
}
```

`crates/memphis-tui` becomes a thin shell: Crossterm events → `CockpitAction` → Ratatui
renderer. `apps/memphis-gui` becomes the second shell: Tauri events → `CockpitAction` →
HTML renderer.

**Why this and not "write a GUI that calls the host protocol":** the GUI must be able to
chat (F2), and only the Rust stack streams. Sharing the core means the GUI inherits the
TUI's streaming, its tool executor, its guards and its 1 200-line buffer semantics —
identical behaviour, not a lookalike.

**Cost:** mechanical. **Proof:** `cargo test -p memphis-tui` before and after must be
identical, and a live TUI session must behave the same.

### Layer 2 — Fix the cockpit's ergonomics (highest value per LOC)

These land in the core, so the GUI inherits them for free.

| #   | Change                                                                                             | Where                                                       | LOC  |
| --- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---- |
| E1  | Render the caret; keep it in view by horizontally scrolling the input                              | `widgets/prompt.rs`, `ui.rs` (`Frame::set_cursor_position`) | ~60  |
| E2  | Multi-row prompt: Alt+Enter inserts a newline, Enter submits; area grows to ≤8 rows and scrolls    | `app.rs` handle_key + layout                                | ~120 |
| E3  | `Ctrl+F` — search over the scrollback; matches highlighted, Enter steps to the next one            | `app.rs` + `widgets/body.rs` + `widgets/search.rs`          | ~250 |
| E4  | `Ctrl+Y` — copy the last assistant answer to the clipboard via OSC 52                              | `app.rs` + `main.rs`                                        | ~40  |
| E5  | `/sessions` gains an interactive picker (provider, model, session id) instead of a printed summary | `app.rs`                                                    | ~100 |

**Status (2026-10-27): E1, E2, E3 and E4 are implemented and merged** — see the
commits `feat(tui): a real caret, an editable multi-line prompt, and
copy-to-clipboard` and `feat(tui): Ctrl+F searches the scrollback`. E5 is
deliberately still open: the search (E3) covers most of what the picker
was for, and a picker is a bigger change to `/sessions` semantics than
the rest of this table.

One binding differs from the table above: the search is `Ctrl+F`, not
`Ctrl+R`. `Ctrl+R` already meant "refresh" in the TUI, and the main
loop's comment had promised "F5 / Ctrl-R" for refresh while only ever
wiring up the Ctrl half — F5 now refreshes too, which frees `Ctrl+F` for
the search.

E4 matters more than it looks: mouse capture is **off** by default because copying is the
dominant use case (see the comment on `mouse_capture_enabled`), which means the operator
currently has to reach for the mouse to grab an answer.

### Layer 3 — Tauri as the second shell

`apps/memphis-gui/` (outside the Cargo workspace — the `glib-sys` reason in `Cargo.toml`
is valid and must stay).

- **Backend (Rust):** depends on `memphis-cockpit` → same chat engine, same streaming.
  Spawns `memphis tui host --stdio-json` as a child process and bridges NDJSON ↔ Tauri
  events, which gives it all 37 host capabilities (doctor, agents, config, surface policy,
  `telegram.send`, tier elevation) **without writing a single line of business logic** —
  which is exactly what `MEMPHIS_ARCHITECTURE_LAYERS.md` requires of a surface.
- **Frontend:** vanilla TypeScript + CSS, no framework, no build step beyond `tsc`.
  `StyledLine` + `LineTone` → `<div class="tone-title">`. ~400 LOC. A framework would
  open the unresolved F7 debate and cost more than the surface itself on this hardware.
- **Where the GUI earns its keep** (the things a terminal does badly): real text
  selection and `Ctrl+F`; markdown and code blocks with syntax highlighting; sortable,
  filterable tables for sessions / chains / memory hits; images; a link to a chain block
  instead of 1 200 lines of terminal text.
- **Contract test:** mirror `tests/unit/tui-host.test.ts` — spawn the GUI backend, drive
  the core, assert the model output. The previous Tauri attempt died because it had
  neither a build path nor a test; both are mandatory this time.

### Layer 4 — Protocol v2: the two changes the GUI forces

1. **Per-capability concurrency.** Replace the global "host is busy" rejection with a
   per-capability rule: long-running, cancellable capabilities (`chat.turn`) may run
   alongside short reads (`health.status`, `doctor.run`).
2. **Streaming chat on the host protocol** (`chat.turn` + a `chunk` event), so the GUI
   _and_ Telegram/CLI can share one engine. Today the protocol has no chat capability at
   all — which is precisely why a GUI built on it alone would be second-rate.

Both are backwards compatible: the `ready` handshake advertises capabilities, so a new
client against an old host simply sees fewer of them, and an old client against a new
host ignores unknown events.

---

## Part 4 — What this explicitly does NOT do

- **Does not** rewrite the chat engine in TypeScript, and **does not** make the GUI depend
  on the TS stack (F2: no streaming, and a second tool-execution policy).
- **Does not** introduce React / shadcn / Svelte / Leptos (F7: unresolved since May, and
  disproportionate on 2 cores).
- **Does not** put Tauri in the Cargo workspace — `cargo build --workspace` must keep
  working for every pure-Rust crate and for CI.
- **Does not** re-introduce `apps/memphis-gui` as a stub. No build path, no test → not
  merged. That rule is what produced ADR-010.
- **Does not** add a second implementation of the seven screens in the GUI. The GUI
  renders the _same_ `Vec<StyledLine>` the TUI renders. Presentation may differ;
  semantics may not.
- **Does not** touch the Rust/TS chat-stack split beyond adding `chat.turn` to the
  protocol. Unifying the stacks is a separate, much larger decision.

---

## Part 5 — Sequencing: what to build, in what order

The order is by _value delivered if the work stops here_. Each step is independently
mergeable and independently useful.

| #   | Step                                                                 | Effort    | Value if stopped here                                               | Risk                                                             |
| --- | -------------------------------------------------------------------- | --------- | ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | **E1–E5 ergonomics** in the existing TUI (no refactor)               | ~2 days   | High — fixes the caret, multi-line prompts, scrollback search, copy | Low: additive, no architecture touched                           |
| 2   | **Layer 1 extraction** into `memphis-cockpit`                        | ~1 day    | Medium — no user-visible change, but unblocks everything else       | Medium: 8 300 LOC moves; mitigated by an identical test baseline |
| 3   | **Tauri shell** (`apps/memphis-gui`, vanilla TS frontend)            | ~3–5 days | High — the window, the tables, the rich rendering                   | Medium: new build path, must be pinned by CI                     |
| 4   | **Protocol v2** (`chat.turn`, per-capability concurrency, streaming) | ~2 days   | Medium — unifies GUI/Telegram/CLI on one engine                     | Medium: touches the TS host and its consumers                    |

Step 1 is listed first on purpose: it is a day of work that makes the _existing,
authoritative_ cockpit materially better, and it does not depend on any of the
architecture. Steps 2–4 are the GUI path.

**Step 3 must not start before step 2.** A Tauri app written directly against today's
`app.rs` would have to fork it — which is how the first Tauri attempt became a stub.

---

## Part 6 — Risks, and the test that would falsify each

| Risk                                                  | Falsifier (what would prove the risk real)                                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Extraction breaks the TUI                             | `cargo test -p memphis-tui` differs before/after, or a live TUI session misbehaves                                                                                             |
| The Tauri shell rots again (the ADR-010 failure mode) | a CI job that installs the 5 system packages and runs `cargo check` on `apps/memphis-gui/src-tauri` goes green and is then allowed to rot — i.e. it is missing or not blocking |
| GUI drifts from TUI behaviour                         | the two shells produce different `Vec<StyledLine>` for the same scripted input sequence — caught by a golden test asserting both are identical                                 |
| Protocol v2 breaks the existing TUI client            | `tests/unit/tui-host.test.ts` or the Rust extension-host integration test fails against a v2 host                                                                              |
| The GUI costs more than it gives on this hardware     | resident memory of the GUI process + webview exceeds ~300 MB, or the 2-core box visibly degrades during a reasoning-model turn                                                 |
| Layer 2 makes the workspace bigger for no gain        | `cargo build --workspace` time or CI minutes increase measurably without a matching capability                                                                                 |

---

## Part 7 — Open decisions for the operator

1. **Is a graphical surface wanted at all?** Everything in Layer 3 is optional. Layers 1
   and 2 stand alone. If the answer is "no", stop after step 2 and keep the protocol
   work.
2. **Tauri vs a lighter shell.** Tauri needs a webview (≈300 MB resident). A Quickshell
   QML panel — the Omarchy-native option — would speak the _same_ NDJSON protocol at a
   fraction of the cost, and would integrate with the desktop the operator already runs.
   The protocol-first design (Layer 4) is what makes that a real choice rather than a
   rewrite. **Recommendation: build the protocol first, then ship Tauri as the reference
   client and treat Quickshell as the cheap one.**
3. **Does the Rust/TS chat-stack split get unified?** This ADR explicitly does not
   decide it. It is the largest remaining source of behavioural difference between
   surfaces, and it deserves its own ADR if the operator wants it.
4. **Frontend framework.** Recommendation: none (F7). Reversible later — a framework
   only touches the ~400 LOC renderer.

---

## Evidence index

Everything asserted above was measured on the operator host on 2026-10-26, not recalled:

- `crates/memphis-tui/src/{app,client}.rs` — no `ratatui` import (F1)
- `src/providers/index.ts:284` — `stream: false` (F2)
- `crates/memphis-operator/src/chat_session.rs:242` and
  `src/infra/storage/sqlite/repositories/operator-chat-session-repository.ts:168` —
  same table, complementary columns (F2)
- `crates/memphis-tui/src/main.rs:98,105,122,127` — `Hide` on enter, `Show` on exit (F3)
- `grep -rn set_cursor_position crates/ src/` — no match (F3)
- `crates/memphis-tui/src/app.rs:25` — `OUTPUT_BUFFER_LIMIT = 1200` (F4)
- `src/infra/tui-host/index.ts:80-85` — global in-flight rejection (F5)
- `pkg-config --modversion webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 gtk+-3.0`
  and `ayatana-appindicator3-0.1.pc` (F6)
- `review.md:13` — frontend framework open since 2026-05-12 (F7)
- `Cargo.toml` `exclude` — the stale "not present on the operator host" claim (§1.2)
