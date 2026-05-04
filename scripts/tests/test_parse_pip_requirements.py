#!/usr/bin/env python3
"""Fixture tests for `scripts/parse-pip-requirements.py` — Sprint I N30 gate.

The dep-freeze CI gate symmetric-diffs the output of this parser to
decide whether a PR adds/removes/bumps a pip dep. A regression in the
parser silently disarms the classification gate, which is the failure
mode N30 was created to prevent. These fixture tests pin the
classification-relevant cases.

Run via: `python3 scripts/tests/test_parse_pip_requirements.py`
Exits 0 on success, 1 on first assertion failure with a clear message.
"""
from __future__ import annotations

import pathlib
import subprocess
import sys

SCRIPT = pathlib.Path(__file__).resolve().parent.parent / "parse-pip-requirements.py"


def run(text: str) -> list[tuple[str, str]]:
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input=text,
        capture_output=True,
        text=True,
        check=True,
    )
    rows: list[tuple[str, str]] = []
    for line in proc.stdout.splitlines():
        if not line:
            continue
        name, _, spec = line.partition("\t")
        rows.append((name, spec))
    return rows


def names(rows: list[tuple[str, str]]) -> list[str]:
    return [name for name, _ in rows]


def expect(actual: object, expected: object, label: str) -> None:
    if actual != expected:
        sys.stderr.write(f"FAIL ({label})\n  expected: {expected!r}\n  actual:   {actual!r}\n")
        sys.exit(1)


def test_basic_pinned_deps() -> None:
    rows = run("requests==2.31.0\nnumpy>=1.26\n")
    expect(names(rows), ["requests", "numpy"], "basic pinned deps")


def test_directives_are_skipped() -> None:
    rows = run(
        "-r other.txt\n"
        "--extra-index-url https://pypi.example/\n"
        "--index-url https://pypi.org/simple/\n"
        "--find-links ./wheels/\n"
        "--no-binary :all:\n"
        "--trusted-host pypi.example\n"
        "--require-hashes\n"
        "-c constraints.txt\n"
        "requests==2.31\n"
    )
    expect(names(rows), ["requests"], "all directives skipped, only requests survives")


def test_comments_and_blanks() -> None:
    rows = run(
        "# a header comment\n"
        "\n"
        "requests==2.31  # pinned for security\n"
        "   # indented comment\n"
        "numpy\n"
    )
    expect(names(rows), ["requests", "numpy"], "comments + blanks skipped")


def test_pep503_normalization() -> None:
    rows = run("Foo_Bar==1.0\nfoo-bar==1.0\nfoo.bar==1.0\n")
    # All three normalize to `foo-bar`.
    expect(names(rows), ["foo-bar", "foo-bar", "foo-bar"], "PEP-503 normalization collapses cosmetic variants")


def test_extras_and_markers_dropped_from_name() -> None:
    rows = run('requests[socks]==2.31; python_version < "3.11"\n')
    expect(names(rows), ["requests"], "extras + env markers stripped from name")


def test_url_at_form() -> None:
    rows = run("memphis-tool @ git+https://example/x.git@main\n")
    expect(names(rows), ["memphis-tool"], "PEP 508 URL @ form keeps LHS as name")


def test_editable_install_strips_flag() -> None:
    rows = run("-e git+https://example/repo.git#egg=mypkg\n")
    # After flag strip the line begins with `git+...` so identity is the URL.
    expect(len(rows), 1, "editable install produces exactly one row")
    expect(
        rows[0][0].startswith("git+"),
        True,
        "editable install URL identity (not 'mypkg' — pip-installed name only known after egg fetch)",
    )


def test_inline_url_fragment_preserved_in_spec() -> None:
    rows = run("git+https://example/x.git#egg=mypkg\n")
    # The spec column must keep the `#egg=` fragment so a target change
    # surfaces in the diff. The parser's identity for URL deps is the
    # URL itself.
    expect(len(rows), 1, "URL dep produces one row")
    expect("egg=mypkg" in rows[0][1], True, "egg=... fragment preserved in spec")


def test_local_editable_bare_dot_uses_local_editable_prefix() -> None:
    # `-e .` has no alphanumeric chars after flag strip → `local-editable:.`
    # identity. This is the only path the parser treats specially. Local
    # paths *with* alphanumeric chars (`-e ./local-pkg`) get normalized
    # like normal names and still surface in the diff via PEP-503
    # collapsing — the test below pins that path-shape behavior.
    rows = run("-e .\n")
    expect(len(rows), 1, "bare dot editable produces one row")
    expect(rows[0][0].startswith("local-editable:"), True, f"got name {rows[0][0]!r}")


def test_local_editable_with_path_keeps_diff_identity() -> None:
    # The parser's PEP-503 collapse is stable: `./local-pkg` → `-/local-pkg`.
    # The exact name doesn't matter for the gate — the gate symmetric-
    # diffs whatever the parser emits. What matters is the identity is
    # stable and changes-to-the-spec surface in the diff. Pin both.
    rows_a = run("-e ./local-pkg\n")
    rows_b = run("-e ./local-pkg\n")
    expect(rows_a, rows_b, "stable identity across runs")
    rows_c = run("-e ./other-pkg\n")
    expect(rows_a != rows_c, True, "different path → different identity (gate trips)")


def main() -> int:
    cases = [
        test_basic_pinned_deps,
        test_directives_are_skipped,
        test_comments_and_blanks,
        test_pep503_normalization,
        test_extras_and_markers_dropped_from_name,
        test_url_at_form,
        test_editable_install_strips_flag,
        test_inline_url_fragment_preserved_in_spec,
        test_local_editable_bare_dot_uses_local_editable_prefix,
        test_local_editable_with_path_keeps_diff_identity,
    ]
    for case in cases:
        case()
    sys.stdout.write(f"OK ({len(cases)} cases)\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
