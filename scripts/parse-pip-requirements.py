#!/usr/bin/env python3
"""Parse pip-style requirements.txt from stdin into name/spec rows.

Emits `<normalized-name>\t<original-line>` for each dependency and
skips pip directives (`-r other.txt`, `--extra-index-url ...`,
`-e ...`, comments, blanks). Used by .github/workflows/dep-freeze-check.yml
to compute symmetric-diff of deps for the classification gate, so it
must faithfully ignore anything that isn't a distribution requirement.

PEP 503 name normalization is applied so `Foo_Bar`, `foo-bar`, and
`foo.bar` all collapse to `foo-bar` and survive cosmetic rename noise.
"""
from __future__ import annotations

import re
import sys


def _strip_comment(raw: str) -> str:
    """Strip pip-style comments while preserving URL fragments.

    pip treats `#` as a comment delimiter ONLY when preceded by whitespace
    or at line start. Inline fragments such as `git+https://x/y#egg=foo`
    and `pkg @ url#subdirectory=sub` are meaningful parts of the
    requirement — truncating them hides before/after differences and
    lets unclassified target changes slip past the gate.
    """
    out_chars: list[str] = []
    prev_space = True  # treat line start as whitespace-preceded
    for ch in raw:
        if ch == "#" and prev_space:
            break
        out_chars.append(ch)
        prev_space = ch.isspace()
    return "".join(out_chars).strip()


_EDITABLE_PREFIXES = ("-e ", "-e\t", "--editable ", "--editable\t", "--editable=")
_NON_DEP_PREFIXES = (
    "-r ", "-r\t", "--requirement ", "--requirement=",
    "-c ", "-c\t", "--constraint ", "--constraint=",
    "--extra-index-url", "--index-url", "--find-links",
    "--no-binary", "--only-binary", "--trusted-host",
    "--pre", "--no-deps", "--prefer-binary", "--require-hashes",
)


def parse(lines):  # type: ignore[no-untyped-def]
    for raw in lines:
        line = _strip_comment(raw.rstrip("\n"))
        if not line:
            continue
        # Editable installs (`-e git+...#egg=foo`, `--editable .`) ARE
        # dependencies — pip treats them as package requirements, just
        # installed in dev mode. Strip the flag and fall through to
        # normal parsing so a changed editable target still trips the
        # classification gate.
        for prefix in _EDITABLE_PREFIXES:
            if line.startswith(prefix):
                line = line[len(prefix):].lstrip("= \t")
                break
        # Non-dep pip option lines (include directives, index URLs, etc.)
        if any(line.startswith(p) for p in _NON_DEP_PREFIXES):
            continue
        # Remaining bare `-` / `--` prefixes are unknown pip flags;
        # skip rather than treat as a dependency name.
        if line.startswith("-") or line.startswith("--"):
            continue

        # VCS / URL installs:
        #   pkg @ git+https://...       → LHS before '@' is the name
        #   git+https://...#egg=pkg     → URL itself is identity
        if line.startswith(("git+", "http://", "https://", "file://")):
            name_part = line
        elif "@" in line and not line.startswith(("git+", "http", "file")):
            name_part = line.split("@", 1)[0].strip()
        else:
            name_part = line

        # Strip extras (`pkg[socks]`), env markers (`; python_version < "3.11"`),
        # and version spec operators. Keep the original line as the spec
        # so bumps/changes produce a diff.
        prefix = re.split(r"[<>=!~;\s]", name_part, maxsplit=1)[0]
        name = prefix.split("[", 1)[0].strip()
        if not name:
            continue

        # PEP 503 name normalization requires at least one alphanumeric
        # character. Local editable installs (`-e .`, `-e ./pkg`) lack
        # a PEP-503 name until installed; fall back to the full line as
        # identity so every change in the path/spec still diffs.
        if not re.search(r"[A-Za-z0-9]", name):
            print(f"local-editable:{line}\t{line}")
            continue

        norm = re.sub(r"[-_.]+", "-", name).lower()
        print(f"{norm}\t{line}")


if __name__ == "__main__":
    parse(sys.stdin)
