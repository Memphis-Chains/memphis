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


def parse(lines):  # type: ignore[no-untyped-def]
    for raw in lines:
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        # pip option lines (`-r other.txt`, `-c constraints.txt`,
        # `--extra-index-url ...`, `-e .`, etc.) — not dependencies.
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

        norm = re.sub(r"[-_.]+", "-", name).lower()
        print(f"{norm}\t{line}")


if __name__ == "__main__":
    parse(sys.stdin)
