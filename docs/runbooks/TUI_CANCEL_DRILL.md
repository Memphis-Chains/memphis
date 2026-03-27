# Rust TUI Cancel Drill

Use this runbook when release docs or operator checks require the manual interactive Rust TUI cancel proof.

## Preconditions

- Run from a source checkout with the normal Memphis runtime bootstrapped.
- Start from the repo root.
- Use a shell where `memphis tui` launches the active Rust console.
- No other active command should be running when the drill starts.

## Scenario A: Native Streaming Chat

1. Launch the console:

   ```bash
   memphis tui
   ```

2. Set the provider to deterministic local streaming for the drill:

   ```text
   /provider local-fallback
   ```

3. Submit this prompt as plain text:

   ```text
   RC_CANCEL_NATIVE alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha
   ```

4. Wait until streamed output is visibly arriving, then press `Ctrl+C`.

Expected result:
- the TUI stays open,
- the transcript shows a cancel-request line for `native chat`,
- the transcript later shows `native chat cancelled`,
- no partial assistant turn is committed as a completed response.

5. Immediately run:

   ```text
   /overview
   ```

Expected result:
- `/overview` renders normally in the same session, proving the TUI stayed usable after cancellation.

## Scenario B: Host-Backed Command

1. Start a long host-backed command:

   ```text
   /doctor --deep
   ```

2. After the command starts printing host-backed lines, press `Ctrl+C`.

Expected result:
- the TUI stays open,
- the transcript shows a cancel-request line for `TS host: doctor`,
- the transcript later shows `TS host: doctor cancelled`.

3. Immediately run:

   ```text
   /telegram
   ```

Expected result:
- the Telegram operator surface renders normally in the same session.

## Idle Exit Check

1. After both cancellation scenarios complete and no task is running, press `Ctrl+C` again.

Expected result:
- the TUI exits cleanly.

## Failure Conditions

Treat the drill as failed if any of the following happens:

- the first `Ctrl+C` exits the TUI while work is still active,
- the transcript never shows a cancel-request line,
- the transcript never shows the matching `<command label> cancelled` line,
- `/overview` or `/telegram` fails immediately after a cancellation,
- an unsupported slash command silently reaches the legacy bridge without an explicit `/legacy ...` prefix.
