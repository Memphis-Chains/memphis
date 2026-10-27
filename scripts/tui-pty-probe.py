#!/usr/bin/env python3
"""Drive the Memphis Ratatui TUI through a real pty and inspect what it draws.

The `script` shell is not enough: without a window size the pty reports
0x0 and ratatui renders an empty screen. This harness sets the pty size
explicitly, feeds keystrokes, and then looks for the escape sequences
that prove the caret exists:

  ESC [ ? 25 h   show cursor   (ratatui emits this ONLY when a frame
                                requested a cursor position)
  ESC [ r ; c H  move cursor   (the caret's absolute position)

Usage: tui_pty_probe.py [binary]
"""
import fcntl
import os
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

ROWS, COLS = 40, 100
BOOT_SECONDS = 20.0


def pump(master, sink, seconds):
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([master], [], [], 0.2)
        if not ready:
            continue
        try:
            data = os.read(master, 65536)
        except OSError:
            return
        if not data:
            return
        sink.extend(data)


def main() -> int:
    binary = sys.argv[1] if len(sys.argv) > 1 else "./target/debug/memphis-tui"
    binary = os.path.abspath(binary)

    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    # Read the size back from the master side — the pty may have a
    # different size than we asked for, and the TUI's layout depends on
    # what the terminal reports, not on what we intended.
    packed = fcntl.ioctl(master, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
    actual_rows, actual_cols, _, _ = struct.unpack("HHHH", packed)
    print(f"pty size        : {actual_rows} rows x {actual_cols} cols (asked {ROWS}x{COLS})")

    proc = subprocess.Popen(
        [binary],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
        cwd=os.getcwd(),
        # crossterm reads the terminal size from /dev/tty, not from
        # stdout. Without a new session the child inherits the agent's
        # controlling terminal and sizes its layout to THAT (42 rows),
        # while its output goes to the pty. setsid drops the
        # controlling terminal, so /dev/tty is unavailable and
        # crossterm falls back to the pty we actually created.
        start_new_session=True,
    )
    os.close(slave)

    out = bytearray()
    pump(master, out, BOOT_SECONDS)
    after_boot = len(out)

    os.write(master, b"hello")
    pump(master, out, 1.5)
    typed_at = len(out)

    os.write(master, b"\x1b[D\x1b[D")  # Left, Left
    pump(master, out, 1.5)

    os.write(master, b"X")
    pump(master, out, 1.5)
    after_edit = len(out)

    # Alt+Enter: a newline in the input, so the prompt grows a row.
    os.write(master, b"\x1b\r")
    pump(master, out, 1.5)
    after_newline = len(out)

    # Ctrl+Y: copy the last assistant answer (OSC 52).
    os.write(master, b"\x19")
    pump(master, out, 1.5)
    after_copy = len(out)

    # Ctrl+F: the scrollback search. The transcript carries the provider
    # status list, so "anthropic" is guaranteed to be in there.
    os.write(master, b"\x06")
    pump(master, out, 1.0)
    os.write(master, b"anthropic")
    pump(master, out, 1.5)
    after_search = len(out)

    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        proc.kill()

    os.close(master)
    text = out.decode("utf-8", errors="replace")

    show = len(re.findall(r"\x1b\[\?25h", text))
    hide = len(re.findall(r"\x1b\[\?25l", text))
    moves = re.findall(r"\x1b\[(\d+);(\d+)H", text)

    print("=== TUI pty probe ===")
    print(f"binary           : {binary}")
    print(f"bytes captured   : {len(out)} (boot phase: {after_boot})")
    print(f"cursor shown     : {show}  (ESC[?25h)")
    print(f"cursor hidden    : {hide}  (ESC[?25l)")
    print(f"cursor positions : {len(moves)}")
    if moves:
        print(f"first position   : row={moves[0][0]} col={moves[0][1]}")
        print(f"last position    : row={moves[-1][0]} col={moves[-1][1]}")
        # The caret walks left by two columns and back right by one as
        # the operator types — the column must follow.
        cols = [int(c) for _r, c in moves]
        distinct = sorted(set(cols))
        print(f"distinct columns : {distinct}")

    # Strip the escape sequences so the drawn text can be inspected.
    printable = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", text)
    printable = re.sub(r"\x1b\][^\x07]*\x07", "", printable)
    body = printable.replace("\r", "").replace("\n", " ")

    print(f"visible chars    : {len(body.strip())}")
    for needle in ("> hello", "helXo"):
        print(f"screen contains {needle!r}: {needle in body}")

    # The caret position is the move that FOLLOWS "show cursor":
    # ratatui flushes the diff first (moving the cursor around to write
    # cells) and only then places the caret. Any other ESC[r;cH in the
    # stream is ratatui's own drawing, not the insertion point.
    caret_re = re.compile(r"\x1b\[\?25h(?:\x1b\[\?25l)?\x1b\[(\d+);(\d+)H")

    def carets_in(chunk):
        return [(int(r), int(c)) for r, c in caret_re.findall(chunk)]

    typed_carets = carets_in(out[typed_at:after_edit].decode("utf-8", "replace"))
    newline_carets = carets_in(out[after_edit:after_newline].decode("utf-8", "replace"))
    print(f"caret while typing   : {typed_carets[-6:]}")
    print(f"caret after Alt+Enter : {newline_carets[-6:]}")

    # Ctrl+Y: with no assistant answer in this fresh session the TUI
    # must say so instead of silently doing nothing. The OSC 52 path
    # itself is covered by the unit tests in clipboard.rs.
    copy_chunk = out[after_newline:after_copy]
    copy_text = re.sub(r"\x1b\[[0-9;?]*[a-zA-Z]", "", copy_chunk.decode("utf-8", "replace"))
    print(f"OSC 52 emitted on Ctrl+Y: {b'\\x1b]52;c;' in copy_chunk}")
    print(f"Ctrl+Y noted          : {'nothing to copy' in copy_text}")

    # Anything drawn outside the pty bounds is suspicious — dump it.
    out_of_bounds = [
        (m.start(), m.group(0))
        for m in re.finditer(r"\x1b\[(\d+);(\d+)H", text)
        if int(m.group(1)) > actual_rows or int(m.group(2)) > actual_cols
    ]
    print(f"out-of-bounds moves: {len(out_of_bounds)}")
    for offset, seq in out_of_bounds[:4]:
        start = max(0, offset - 60)
        print(f"  {seq!r} context: {text[start:offset+20]!r}")

    all_rows = [int(r) for r, _c in re.findall(r"\x1b\[(\d+);(\d+)H", text)]
    all_cols = [int(c) for _r, c in re.findall(r"\x1b\[(\d+);(\d+)H", text)]
    if all_rows:
        print(f"max row drawn   : {max(all_rows)} (1-based)")
        print(f"max col drawn   : {max(all_cols)} (1-based)")

    # The search bar renders as one span: "/<query>  <n>/<total>".
    search_text = re.sub(
        r"\x1b\[[0-9;?]*[a-zA-Z]", "", out[after_copy:after_search].decode("utf-8", "replace")
    )
    # A diff renderer writes only the cells that changed, so the query
    # never appears as one contiguous string in the byte stream. The
    # match counter does, because each keystroke rewrites the whole
    # counter cell — and its value narrows as the query narrows.
    counts = re.findall(r"\d+/\d+", search_text)
    print(f"search bar shows a count  : {bool(counts)} -> {counts[:6]}")
    # Reverse video is how a match is highlighted. Crossterm may combine
    # the attribute with others in one SGR run, so look for the "7"
    # attribute inside any SGR sequence rather than for a bare ESC[7m.
    sgr = re.findall(rb"\x1b\[([0-9;]*)m", out[after_copy:after_search])
    reversed_runs = [run for run in sgr if b"7" in run.split(b";")]
    print(f"a match is highlighted    : {bool(reversed_runs)} (SGR runs with attr 7: {len(reversed_runs)})")

    print("--- last 300 visible chars ---")
    print(body[-300:])

    ok = show > 0 and len(typed_carets) > 0 and "/anthropic" in search_text
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
