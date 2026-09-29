# Bug: Memphis-TUI corrupts stdin input with ANSI escape codes

## Summary

Memphis-TUI (the Rust-based operator cockpit) injects ANSI escape sequences into
stdin when relaying operator input to shell commands. This corrupts interactive
prompts such as `sudo`'s password prompt, causing:

- Authentication failures for valid passwords
- Potential argument corruption for destructive commands
- Operator frustration that may lead to insecure workarounds (e.g. writing
  passwords to files)

## Severity

**HIGH (security-adjacent)**

This blocks tier-2 sudo-mediated operations from being executed through
Memphis-TUI without using a separate terminal.

## Reproduction

1. Operator has memphis-tui running as their primary interface.
2. Operator executes a command requiring `sudo` (e.g.
   `sudo bash /tmp/prep-usb.sh`).
3. `sudo` prompts for password via stdin.
4. Operator pastes password from clipboard (password manager, other terminal,
   etc.) or types it.
5. The input that reaches `sudo` is not the plain password but a sequence of
   ANSI escape codes interspersed with fragments of the typed text.

### Observed (live, 2026-09-17 ~16:35 CEST)

After three malformed input attempts, `sudo` reports:

```
sudo: Authentication failed, try again.
sudo: Authentication failed, try again.
sudo-rs: Maximum 3 incorrect authentication attempts
```

The pasted input was reconstructed from the captured sequence as:

```
[<35;104;41M[<35;122;47M[<35;120;48M9;49M2;47M[<35;116;456;48M<35;150;29M35;169;25M;37M<35;167;48M65;48M
```

This is clearly a sequence of CSI cursor-position escape codes, not the
intended password bytes.

## Expected behaviour

- Plain-text input from the operator (typed or pasted) should be forwarded
  unchanged to the underlying process's stdin.
- ANSI escape sequences should only be emitted on the **output** path (for
  rendering), not injected into the **input** path.

## Actual behaviour

- The input pipe receives a transformed stream containing cursor-positioning
  sequences.
- Interactive prompts (sudo, ssh, passphrases, expect-style tools) fail.
- Non-interactive commands appear to work because they do not consume stdin
  semantically.

## Environment

- OS: Ubuntu 25.10 (Questing Quokka), kernel 6.17.0-41-generic
- Display: XFCE / X11
- Shell where bug was observed: memphis-tui (Rust)
- Working real terminal: xfce4-terminal (plain input works correctly there)
- `sudo` flavor: `sudo-rs` (Rust implementation)

## Workaround

Open a real terminal (`xfce4-terminal`, `xterm`, `gnome-terminal`) instead of
using memphis-tui for any command that:

- Reads a password or passphrase from stdin (`sudo`, `ssh-keygen`, `gpg`,
  `pass`, `vault`, ...)
- Relies on interactive prompts
- Performs destructive operations (`dd`, `wipefs`, `mkfs`, `rm -rf`, ...)

Inside the real terminal:

1. Type the command manually (do not paste it through memphis-tui).
2. Type passwords from the keyboard (do not paste from clipboard).
3. Wait for completion before returning to memphis-tui.

## Likely root cause (unverified)

The most probable cause is one of:

1. `crates/memphis-tui/src/input.rs` or similar is processing pasted text as
   if it were command-palette input and injecting cursor-positioning escape
   codes to update the on-screen prompt.
2. The TUI multiplexes the same input channel for command rendering and for
   stdin forwarding, with state contamination between the two.
3. Clipboard paste is being processed by an ANSI-aware widget before being
   forwarded to the child process's stdin.

A focused investigation is needed in `crates/memphis-tui/src/input.rs` and
related rendering code paths.

## Related history

- Decision journal #178 (anti-confab, `│` separator) — same pattern of TUI
  injecting special characters into operator-visible output. This bug is the
  input-side counterpart.
- Decision journal #191 — anti-hubris refusal to auto-run destructive USB
  format. The refusal turned out to be protective: had the script executed
  with corrupted stdin arguments, `dd` could have targeted the wrong device.

## Acceptance criteria

A fix is acceptable when:

1. Typing or pasting a plain-text password into a command launched from
  memphis-tui causes `sudo` (and similar tools) to authenticate successfully.
2. The input stream received by the child process is byte-for-byte identical
  to what the operator typed or pasted.
3. No ANSI escape sequences appear in the input stream that did not come from
  the operator's keyboard or clipboard.
4. Existing rendering behaviour (cursor positioning, colors) on the output
  side is unchanged.

## Proposed fix approach

- Separate the input handling for command-palette / chat input from the stdin
  forwarding for child processes.
- Forward raw bytes from stdin to child processes without transformation.
- If terminal mode switching is required (raw vs cooked), do it at the PTY
  allocation layer, not at the input transformation layer.
- Add a regression test that spawns a child process, sends a known
  multi-byte string through stdin, and asserts the child receives exactly
  those bytes.

## Owner

memphis-tui maintainers (component: `crates/memphis-tui/`)

## Labels

- bug
- security-adjacent
- input
- tier-2-blocker
- needs-repro-confirmation
