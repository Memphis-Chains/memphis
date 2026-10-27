#!/usr/bin/env python3
"""Drive the Memphis Ratatui TUI through a real pty and inspect what it draws.

The `script` shell is not enough: without a window size the pty reports
0x0 and ratatui renders an empty screen. This harness sets the pty size
explicitly, feeds keystrokes, and then reports what the terminal would
actually show.

Modes:

  (default)  the escape-sequence probe: was the cursor shown, where did
             it move, was a search match highlighted.
  --dump     render the final screen as plain text, with the caret
             marked under the insertion point.
  --bench    measure keystroke -> redraw latency.

Usage: tui-pty-probe.py [binary] [--dump] [--bench] [--keys "..."]
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


# --------------------------------------------------------------------------
# A very small VT interpreter: enough for what ratatui's crossterm
# backend emits (CUP, CUU/CUD/CUF/CUB, ED, EL, SGR, text).
# --------------------------------------------------------------------------
class Screen:
    def __init__(self, rows, cols):
        self.rows, self.cols = rows, cols
        self.clear()
        self.cursor_visible = False
        self.cursor = (0, 0)

    def clear(self):
        self.cells = [[(" ", False) for _ in range(self.cols)] for _ in range(self.rows)]
        self.attrs = [[0 for _ in range(self.cols)] for _ in range(self.rows)]
        self.x = 0
        self.y = 0
        self.attr = 0

    def put(self, ch):
        if self.y < self.rows and self.x < self.cols:
            self.cells[self.y][self.x] = (ch, True)
            self.attrs[self.y][self.x] = self.attr
        self.x += 1
        if self.x >= self.cols:
            self.x = self.cols - 1

    def text_rows(self):
        return ["".join(c for c, _ in row).rstrip() for row in self.cells]

    def reverse_rows(self):
        """Rows that carry the reverse-video attribute (search hits)."""
        out = []
        for idx, row in enumerate(self.attrs):
            if any(attr & 0x100 for attr in row):
                out.append(idx)
        return out

    def background_rows(self):
        """Rows with a background colour (the current search hit)."""
        out = []
        for idx, row in enumerate(self.attrs):
            if any(attr & 0xF0 for attr in row):
                out.append(idx)
        return out


def feed(screen: Screen, text: str):
    i = 0
    n = len(text)
    while i < n:
        ch = text[i]
        if ch == "\x1b":
            if i + 1 < n and text[i + 1] == "[":
                j = i + 2
                while j < n and not ("@" <= text[j] <= "~"):
                    j += 1
                if j >= n:
                    break
                params, final = text[i + 2 : j], text[j]
                apply_csi(screen, params, final)
                i = j + 1
                continue
            if i + 1 < n and text[i + 1] == "]":
                j = text.find("\x07", i)
                i = (j + 1) if j != -1 else n
                continue
            i += 2
            continue
        if ch == "\r":
            screen.x = 0
        elif ch == "\n":
            screen.y = min(screen.y + 1, screen.rows - 1)
        elif ch == "\x08":
            screen.x = max(0, screen.x - 1)
        elif ch >= " ":
            screen.put(ch)
        i += 1


def apply_csi(screen: Screen, params: str, final: str):
    if params.startswith("?"):
        if final == "h" and "25" in params:
            screen.cursor_visible = True
        elif final == "l" and "25" in params:
            screen.cursor_visible = False
        return
    nums = [int(p) if p.isdigit() else 0 for p in params.split(";")] if params else []

    def arg(idx, default=1):
        return nums[idx] if idx < len(nums) and nums[idx] else default

    if final == "H" or final == "f":
        screen.y = max(0, min(screen.rows - 1, arg(0) - 1))
        screen.x = max(0, min(screen.cols - 1, arg(1) - 1))
    elif final == "A":
        screen.y = max(0, screen.y - arg(0))
    elif final == "B":
        screen.y = min(screen.rows - 1, screen.y + arg(0))
    elif final == "C":
        screen.x = min(screen.cols - 1, screen.x + arg(0))
    elif final == "D":
        screen.x = max(0, screen.x - arg(0))
    elif final == "G":
        screen.x = max(0, min(screen.cols - 1, arg(0) - 1))
    elif final == "J":
        mode = arg(0, 0)
        if mode == 2:
            screen.cells = [[(" ", False) for _ in range(screen.cols)] for _ in range(screen.rows)]
            screen.attrs = [[0 for _ in range(screen.cols)] for _ in range(screen.rows)]
    elif final == "K":
        for x in range(screen.x, screen.cols):
            screen.cells[screen.y][x] = (" ", False)
    elif final == "m":
        if not nums:
            nums = [0]
        # Walk the parameters with an index: the extended colour forms
        # (38;5;N and 48;5;N) carry their own operands, and treating
        # their "0" as a reset would wipe the attributes set before it.
        i = 0
        while i < len(nums):
            value = nums[i]
            if value == 0:
                screen.attr = 0
            elif value == 1:
                screen.attr |= 0x10
            elif value == 7:
                screen.attr |= 0x100
            elif value == 22:
                screen.attr &= ~0x10
            elif value == 27:
                screen.attr &= ~0x100
            elif 30 <= value <= 37:
                screen.attr = (screen.attr & ~0x1F) | (value - 30)
            elif 40 <= value <= 47:
                screen.attr = (screen.attr & ~0xF0) | ((value - 40) << 4)
            elif value == 39:
                screen.attr &= ~0x1F
            elif value == 49:
                screen.attr &= ~0xF0
            elif value in (38, 48):
                # 38;5;N (256 colours) or 38;2;r;g;b (truecolour)
                mode = nums[i + 1] if i + 1 < len(nums) else 0
                width = 2 if mode == 5 else 4
                if mode == 5:
                    colour = nums[i + 2] if i + 2 < len(nums) else 0
                    if value == 38:
                        screen.attr = (screen.attr & ~0x1F) | (colour & 0x1F)
                    else:
                        screen.attr = (screen.attr & ~0xF0) | ((colour & 0x0F) << 4)
                elif mode == 2:
                    if value == 38:
                        screen.attr = (screen.attr & ~0x1F) | 0x07
                    else:
                        screen.attr = (screen.attr & ~0xF0) | 0x70
                i += width
            i += 1


def pump(master, sink, seconds):
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([master], [], [], 0.05)
        if not ready:
            continue
        try:
            data = os.read(master, 65536)
        except OSError:
            return
        if not data:
            return
        sink.extend(data)


def spawn(binary):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
    packed = fcntl.ioctl(master, termios.TIOCGWINSZ, struct.pack("HHHH", 0, 0, 0, 0))
    proc = subprocess.Popen(
        [binary],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        close_fds=True,
        cwd=os.getcwd(),
        # crossterm reads the terminal size from /dev/tty, not from
        # stdout. Without a new session the child inherits the agent's
        # controlling terminal and sizes its layout to THAT, while its
        # output goes to the pty. setsid drops the controlling
        # terminal, so crossterm falls back to the pty we created.
        start_new_session=True,
    )
    os.close(slave)
    return master, proc, struct.unpack("HHHH", packed)[:2]


def bench(binary, samples=12):
    """Keystroke -> next redraw, measured on the real process."""
    master, proc, _ = spawn(binary)
    out = bytearray()
    pump(master, out, BOOT_SECONDS)
    latencies = []
    for i in range(samples):
        marker = len(out)
        os.write(master, b"x")
        start = time.time()
        deadline = start + 2.0
        while time.time() < deadline:
            ready, _, _ = select.select([master], [], [], 0.01)
            if not ready:
                continue
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            out.extend(data)
            if len(out) > marker:
                latencies.append((time.time() - start) * 1000)
                break
        os.write(master, b"\x7f")  # backspace
        pump(master, out, 0.35)
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
    os.close(master)
    if not latencies:
        return None
    latencies.sort()
    return {
        "n": len(latencies),
        "min": latencies[0],
        "median": latencies[len(latencies) // 2],
        "max": latencies[-1],
    }


def dump(binary, keys=b""):
    master, proc, (rows, cols) = spawn(binary)
    out = bytearray()
    pump(master, out, BOOT_SECONDS)
    if keys:
        os.write(master, keys)
        pump(master, out, 2.0)
    else:
        os.write(master, b"")
        pump(master, out, 1.0)
    try:
        proc.terminate()
        proc.wait(timeout=5)
    except Exception:
        proc.kill()
    os.close(master)
    screen = Screen(rows, cols)
    feed(screen, out.decode("utf-8", "replace"))
    return screen


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    binary = os.path.abspath(args[0] if args else "./target/debug/memphis-tui")
    want_dump = "--dump" in sys.argv
    want_bench = "--bench" in sys.argv
    keys = b""
    if "--keys" in sys.argv:
        keys = sys.argv[sys.argv.index("--keys") + 1].encode()

    if want_bench:
        result = bench(binary)
        if result is None:
            print("bench: no frames observed")
            return 1
        print("=== keystroke -> redraw latency ===")
        print(f"binary   : {binary}")
        print(f"samples  : {result['n']}")
        print(f"min      : {result['min']:.1f} ms")
        print(f"median   : {result['median']:.1f} ms")
        print(f"max      : {result['max']:.1f} ms")
        return 0

    if want_dump:
        screen = dump(binary, keys)
        print(f"=== screen dump: {binary} ===")
        print(
            f"pty {screen.rows} x {screen.cols}, "
            f"cursor_visible={screen.cursor_visible}"
        )
        print("+" + "-" * screen.cols + "+")
        for idx, row in enumerate(screen.text_rows()):
            print("|" + row.ljust(screen.cols)[: screen.cols] + "|")
            # Mark the caret under its row so the insertion point is
            # visible in plain text.
            if screen.cursor_visible and idx == screen.y:
                marker = [" "] * screen.cols
                marker[screen.x] = "^"
                print("|" + "".join(marker) + "|")
        print("+" + "-" * screen.cols + "+")
        print(f"cursor at row {screen.y + 1}, col {screen.x + 1} (visible={screen.cursor_visible})")
        reversed_rows = screen.reverse_rows()
        bg_rows = screen.background_rows()
        print(f"reverse-video rows (search hits): {[r + 1 for r in reversed_rows]}")
        print(f"highlighted current hit (bg)   : {[r + 1 for r in bg_rows]}")
        return 0

    # ---- default: the escape-sequence probe ----
    master, proc, (rows, cols) = spawn(binary)
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

    os.write(master, b"\x1b\r")  # Alt+Enter
    pump(master, out, 1.5)
    after_newline = len(out)

    os.write(master, b"\x19")  # Ctrl+Y
    pump(master, out, 1.5)
    after_copy = len(out)

    os.write(master, b"\x06")  # Ctrl+F
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
    caret_re = re.compile(r"\x1b\[\?25h(?:\x1b\[\?25l)?\x1b\[(\d+);(\d+)H")

    def carets_in(chunk):
        return [(int(r), int(c)) for r, c in caret_re.findall(chunk)]

    typed_carets = carets_in(out[typed_at:after_edit].decode("utf-8", "replace"))
    newline_carets = carets_in(out[after_edit:after_newline].decode("utf-8", "replace"))

    search_text = re.sub(
        r"\x1b\[[0-9;?]*[a-zA-Z]", "", out[after_copy:after_search].decode("utf-8", "replace")
    )
    counts = re.findall(r"\d+/\d+", search_text)
    sgr = re.findall(rb"\x1b\[([0-9;]*)m", out[after_copy:after_search])
    reversed_runs = [run for run in sgr if b"7" in run.split(b";")]

    print("=== TUI pty probe ===")
    print(f"binary           : {binary}")
    print(f"bytes captured   : {len(out)} (boot phase: {after_boot})")
    print(f"cursor shown     : {show}  (ESC[?25h)")
    print(f"cursor hidden    : {hide}  (ESC[?25l)")
    print(f"caret while typing   : {typed_carets[-6:]}")
    print(f"caret after Alt+Enter : {newline_carets[-6:]}")
    print(f"search bar shows a count  : {bool(counts)} -> {counts[:6]}")
    print(f"a match is highlighted    : {bool(reversed_runs)} (SGR runs with attr 7: {len(reversed_runs)})")

    all_rows = [int(r) for r, _c in re.findall(r"\x1b\[(\d+);(\d+)H", text)]
    all_cols = [int(c) for _r, c in re.findall(r"\x1b\[(\d+);(\d+)H", text)]
    if all_rows:
        print(f"max row drawn   : {max(all_rows)} (1-based)")
        print(f"max col drawn   : {max(all_cols)} (1-based)")
    return 0 if show > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
