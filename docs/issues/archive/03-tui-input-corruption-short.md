# TUI: input corruption — ANSI escape codes leaking into stdin/commands

## Severity
**HIGH (security-adjacent)**

Re-reported from decision #192 (2026-09-17). Verified recurring during session 2026-09-22 00:20 CEST — operator pasted input to TUI and saw literal ANSI escape sequences (`[<35;55;5M`, `[<35;85;12M89;18M`, etc.) appear in their command buffer.

## Observed

When operator types or pastes into the TUI command palette, the rendered text sometimes contains CSI (Control Sequence Introducer) sequences that should have been stripped at input boundary. Real example from this session:

```
[<35;55;5M[<35;85;12M89;18M[<35;120;45M[<35;120;45M5;120;46M[<35;118;47M[<35;120;47M29M/mode
```

The final 4 characters are the literal `/mode` command the operator intended; the prefix is cursor-positioning escape codes from a clipboard paste.

## Reproduction

1. Open `memphis-tui` (xfce4-terminal, xterm, or any TUInstace)
2. Paste a string containing ANSI CSI sequences into the input field (e.g. paste from terminal that supports mouse reporting, or paste from browser dev tools with `Enable Live Tracking`)
3. Observe: paste includes raw escape codes; intended command is wrapped in garbage
4. If the intended command is destructive (e.g. `/mode`, `/exec`, `/sudo`), the wrapper may be sufficient to be rejected (good) but the operator loses typing context (bad)

100% reproducible if paste source includes escape sequences.

## Expected

Input buffer contains plain text only. ANSI escape sequences filtered at input boundary. Multi-byte UTF-8 preserved.

## Actual

Raw escape codes land in `input_buffer`. Downstream:
- `execute_input` sends the contaminated string to runtime
- runtime parses it as command + ANSI noise
- Command may fail, succeed with garbage args, or (worst case) succeed with truncated command that doesn't match operator intent

## Impact

- **Operator friction**: every paste requires manual cleanup
- **Security-adjacent**: if operator pastes a destructive command (e.g. `sudo bash /tmp/prep-usb.sh`) and ANSI codes corrupt argument parsing, dd may target wrong device (already happened on 2026-09-17, decision #192 era — USB wipe went to right device due to conscious sudo entry, but anti-hubris check paid off)
- **Workaround currently**: open real terminal, type manually. Unacceptable for daily operator workflow.

## Root cause (hypothesis, NOT verified — tier-2 required)

`crates/memphis-tui/src/sanitize.rs` exists with `sanitize_for_tui()` but is called only for **output rendering** (`body.rs`, `status_bar.rs`), NOT for **input buffer**. `handle_paste` in `crates/memphis-tui/src/app.rs` pushes verbatim.

Companion issue: decision #178 reports the `│` separator leaking into chat output — same root cause class (TUI not filtering CSI sequences through the same boundary function).

## Suggested fix

Add `sanitize_input()` in `crates/memphis-tui/src/sanitize.rs` with input-specific rules:
- Strip CSI/OSC escape sequences
- Preserve `\n`, `\t`, multi-byte UTF-8
- No length limit (passwords + commands can be long)

Call `sanitize_input()` in `handle_paste` and `handle_key` in `crates/memphis-tui/src/app.rs` before push to `input_buffer`.

Add regression test `crates/memphis-tui/tests/sanitize-input.test.ts` (or `.rs`).

## Acceptance criteria

- `cargo test -p memphis-tui` passes new test: pasting `\x1b[<35;55;5Mhaslo\x1b[<35;85;12M` results in input buffer = `"haslo"`.
- Manual repro: paste from xfce4-terminal with mouse reporting on → TUI input shows plain text only.
- Existing TUI rendering (body, status_bar, dashboard) still works — sanitize_for_tui rules unchanged.

## Related

- Decision #192 (2026-09-17): first report
- Decision #178: `│` separator bug, same root cause class
- Decision #193: documented workaround ("open real terminal, type manually")
- Postmortem: `docs/postmortems/2026-09-21-soul-append-and-deep-restart.md` (mentions as still-open issue)

## Workaround

Open real terminal (`xfce4-terminal`, `xterm`), type password/command manually. **Don't paste.**

## Owner

@memphis-tui maintainers

## Labels

bug, security-adjacent, input, tier-2-blocker, tui-input, regression
