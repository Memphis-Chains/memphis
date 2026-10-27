# Operator Playbook — measuring the Memphis TUI for real

**Date:** 2026-10-27
**Applies to:** `Memphis-Chains/memphis`, `crates/memphis-tui` (Ratatui cockpit)
**Tool:** `scripts/tui-pty-probe.py` (in `Memphis-Chains/memphis`)

The cockpit is a terminal application, so "does the button work" is a question about
bytes on a pty, not about a DOM. This playbook is the shortest path from "I changed
something" to "I measured that it changed something".

---

## The commands

```bash
cd ~/memphis
cargo build -p memphis-tui

# 1. What does the terminal actually display? (plain text + caret marker)
python3 scripts/tui-pty-probe.py ./target/debug/memphis-tui --dump
python3 scripts/tui-pty-probe.py ./target/debug/memphis-tui --dump --keys $'hello\x1b[D\x1b[DX'

# 2. How fast does a keystroke become a redraw?
python3 scripts/tui-pty-probe.py ./target/debug/memphis-tui --bench

# 3. The escape-sequence probe (cursor shown? where? highlighted?)
python3 scripts/tui-pty-probe.py ./target/debug/memphis-tui
```

`--dump` prints the screen as plain text with the caret marked under the insertion
point, so the result can be read in a chat window or a diff.

---

## Three things that will make you measure the wrong thing

### 1. crossterm reads the terminal size from `/dev/tty`, not from stdout

A child process that inherits a controlling terminal sizes its layout to **that**
terminal while writing its output somewhere else. The symptom: the TUI draws at
40 rows when your pty is 30, and rows appear "below" the screen.

```python
proc = subprocess.Popen([binary], stdin=slave, stdout=slave, stderr=slave,
                        start_new_session=True)   # <- this is the fix
```

`start_new_session=True` (or `setsid`) drops the controlling terminal, so
`/dev/tty` is unavailable and crossterm falls back to the pty you actually created.

**Measured:** without `setsid`, the TUI laid out for 42 rows (the agent's terminal)
while writing into a 30-row pty — 78 drawing operations outside the bounds.

### 2. Ratatui renders differentially, so text never appears as one substring

Consecutive frames rewrite only the cells that changed. `> hello` **never** appears
in the byte stream as a contiguous string. Three of my first checks searched for it
and concluded the feature was broken.

Measure the escape sequences instead:

| Sequence                | Meaning                                   |
| ----------------------- | ----------------------------------------- |
| `ESC[?25h` / `ESC[?25l` | cursor shown / hidden                     |
| `ESC[r;cH`              | cursor moved to row r, column c (1-based) |
| `ESC[7m`                | reverse video (a search hit)              |
| `ESC[38;5;N;48;5;Mm`    | 256-colour foreground / background        |

### 3. The cursor stands _after_ the last character

So a completely full final row puts the caret one column past the area, and
terminals clamp that onto the last character — the caret ends up drawn on top of
the text. A widget that renders a caret must reserve one column.

---

## The evidence that the cockpit changed (2026-10-27)

Both binaries built from the same tree, the same pty size (40×100), the same
keystrokes. The only difference is the commit.

### Before (`3cacca8f`) — typing "hello", then Left, Left, X

```
|> hello                                                                                             |
|● [Mode:B] minimax/MiniMax-M3.1-Flash · ctx:1000k · tok:? · ready · PULSE:healthy · session:primary:|
cursor at row 39, col 9 (visible=False)
```

The `X` landed at the **end**: `> helloX`. `Left` and `Right` were unbound, and
`Backspace` called `String::pop()`, so the input was strictly append-only. The
caret was never shown — `visible=False` — and its position was wherever Ratatui
happened to leave it.

### After (`3a7f723b`) — the same keystrokes

```
|> helXlo                                                                                            |
|      ^                                                                                             |
|● [Mode:B] minimax/MiniMax-M3.1-Flash · ctx:1000k · tok:? · ready · PULSE:healthy · session:primary:|
cursor at row 39, col 7 (visible=True)
```

The `X` landed **in the middle**, and the caret sits exactly under it.

### Latency — the ergonomics cost nothing at the keyboard

Keystroke → next redraw, 12 samples, same host:

|        | min    | median | max     |
| ------ | ------ | ------ | ------- |
| before | 4.6 ms | 7.9 ms | 9.6 ms  |
| after  | 6.4 ms | 7.9 ms | 10.1 ms |

### The search

```
|/ctx:  1/9                                                                                          |
|>                                                                                                   |
|  ^                                                                                                 |
reverse-video rows (search hits): [19, 20, 21, 22, 23, 24, 25, 26, 27]
highlighted current hit (bg)   : [19, 40]
```

Nine provider rows carry the reverse-video attribute; row 19 is the current match
(yellow background). Row 40 is the status bar, which has a navy background of its
own.

---

## A note on the probe itself

The first version of the screen renderer reported "no search highlight" while the
highlight was plainly there. The cause was in the parser, not in the TUI:
`ESC[38;5;0;48;5;3m` is an extended colour, and treating its `0` as a reset wiped
the reverse-video attribute set one sequence earlier. SGR parameters are now walked
with an index, so the extended forms (`38;5;N`, `48;5;N`, `38;2;r;g;b`) consume
their own operands.

**A measurement tool that reports "absent" needs the same scepticism as a feature
that reports "absent".** Check the raw bytes before believing either.

---

## Comparing two builds

```bash
git worktree add --detach /tmp/tui-before 3cacca8f
cd /tmp/tui-before && CARGO_TARGET_DIR=/home/memphis/memphis/target cargo build -p memphis-tui
cp /home/memphis/memphis/target/debug/memphis-tui /tmp/memphis-tui-old

# back in the main tree: cargo still thinks the unit is fresh, so the
# binary on disk is the OLD one — force the relink
cargo clean -p memphis-tui && cargo build -p memphis-tui
```

**Gotcha:** a shared `CARGO_TARGET_DIR` makes two worktrees write the same
`target/debug/<binary>`, and Cargo will not relink a unit whose fingerprint still
looks fresh. `cargo clean -p <crate>` first, or you will measure the old binary
twice and believe the new one is broken.

Verify which binary you actually have:

```bash
strings /tmp/memphis-tui-new | grep -c "no matches"   # 1 = new, 0 = old
```
