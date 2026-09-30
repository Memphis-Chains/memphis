#!/usr/bin/env python3
"""Mutation harness for the tool-schema contract tests in
crates/memphis-operator/src/chat.rs (decision #322).

A test that passes is not evidence that it catches anything. Each mutation
below is a REAL defect the schema contract exists to prevent. A mutation that
survives the suite is a gap in the tests, not a green light.

Usage:  python3 scripts/mutation-schema-harness.py [--full] [--json]

  --full  run every test in the lib, not just the schema block
  --json  emit machine-readable results
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TARGET = REPO / "crates/memphis-operator/src/chat.rs"
BACKUP = Path("/tmp/chat.rs.mutation-harness-backup")

# `cargo test` takes ONE substring filter, not a comma list like nextest.
# Two earlier versions of this file got that wrong and reported every
# mutant as SURVIVED: a filter that matches nothing runs zero tests, so
# every mutation trivially "survives" and the harness reports 17 false
# gaps. The filter was also too narrow - `schema` alone missed
# `list_bearing_tools_mention_the_bare_array_rule_in_their_description`
# (6 tests instead of 7, one false gap).
#
# Lesson: a harness that under-runs the suite is the same class of bug as
# a test that does not assert. Both report green. So: run the full lib,
# and refuse to report results if the baseline is not what we expect.
BASELINE_MIN = 90

# Single substring, only for fast iteration. Not the default.
SCHEMA_FILTER = ""
CARGO = ["cargo", "test", "-p", "memphis-operator", "--lib"]


@dataclass
class Mutation:
    name: str
    old: str
    new: str
    expects: list[str] = field(default_factory=list)
    note: str = ""


MUTATIONS: list[Mutation] = [
    Mutation(
        name="updates-reverts-to-bare-object",
        old='''                "properties": {
                    "updates": soul_updates_schema()
                },''',
        new='''                "properties": {
                    "updates": { "type": "object" }
                },''',
        expects=["tool_schemas_declare_no_array_without_items"],
        note="the exact shape that produced an item-wrapper 18 times",
    ),
    Mutation(
        name="soul_list_field-drops-items",
        old='''        "type": "array",
        "items": { "type": "string" },
        "description": format!(''',
        new='''        "type": "array",
        "description": format!(''',
        expects=["tool_schemas_declare_no_array_without_items"],
        note="array without items: shape known, element type unknown",
    ),
    Mutation(
        name="soul_list_field-becomes-object",
        old='''fn soul_list_field(description: &str) -> Value {
    json!({
        "type": "array",''',
        new='''fn soul_list_field(description: &str) -> Value {
    json!({
        "type": "object",''',
        expects=[
            "tool_schemas_declare_no_array_without_items",
            "soul_write_schema_mirrors_the_runtime_validator_field_tables",
            "soul_write_schema_separates_a_bare_array_from_an_item_wrapper",
        ],
        note="the wrapper made legal: object where runtime demands string[]",
    ),
    Mutation(
        name="soul_list_field-drops-the-rule",
        old='''            "{description} Send a bare JSON array like [\\"first\\", \\"second\\"] — never              {{\\"item\\": [...]}}."''',
        new='''            "{description}"''',
        expects=["soul_write_schema_separates_a_bare_array_from_an_item_wrapper"],
        note="shape correct, model no longer told about the wrapper",
    ),
    Mutation(
        name="self-section-reopens",
        old='''                "description": "What this agent has learned about itself.",
                "additionalProperties": false,''',
        new='''                "description": "What this agent has learned about itself.",''',
        expects=["soul_write_schema_closes_sections_and_rejects_the_item_wrapper"],
        note="unknown fields stop being impossible at schema layer",
    ),
    Mutation(
        name="updates-root-reopens",
        old='''        },
        "additionalProperties": false
    })
}

/// JSON Schema for `memphis_case_query.query`''',
        new='''        }
    })
}

/// JSON Schema for `memphis_case_query.query`''',
        expects=["soul_write_schema_closes_sections_and_rejects_the_item_wrapper"],
        note="SOUL_SECTIONS is a closed set; schema must say so",
    ),
    Mutation(
        name="self-offers-an-item-key",
        old='''                    "evolvedCapabilities": soul_list_field("Capabilities gained through evolution.")
                }''',
        new='''                    "evolvedCapabilities": soul_list_field("Capabilities gained through evolution."),
                    "item": soul_list_field("Legacy transport envelope.")
                }''',
        expects=["soul_write_schema_closes_sections_and_rejects_the_item_wrapper"],
        note="offers the exact key the model is known to invent",
    ),
    Mutation(
        name="user-name-becomes-an-array",
        old='''                    "name": soul_scalar_field("Operator display name."),''',
        new='''                    "name": soul_list_field("Operator display name."),''',
        expects=["soul_write_schema_mirrors_the_runtime_validator_field_tables"],
        note="SOUL_SCALAR_FIELDS says string; schema invites an array",
    ),
    Mutation(
        name="case_query-reopens",
        old='''        "description": "Filter over case chain entries. Every field is optional; omit what you do not filter on.",
        "additionalProperties": false,''',
        new='''        "description": "Filter over case chain entries. Every field is optional; omit what you do not filter on.",''',
        expects=["case_query_schema_matches_the_case_query_struct"],
        note="CaseQuery is a fixed struct",
    ),
    Mutation(
        name="case_query-drops-limit-minimum",
        old='''            "limit": { "type": "integer", "minimum": 1, "description": "Max results (default: 20)." }''',
        new='''            "limit": { "type": "integer", "description": "Max results (default: 20)." }''',
        expects=[],
        note="drops minimum — is any test watching numeric bounds?",
    ),
    Mutation(
        name="case_query-adds-a-field-serde-rejects",
        old='''            "actor": { "type": "string", "description": "Filter by actor." },
            "target": { "type": "string", "description": "Filter by target." },''',
        new='''            "actor": { "type": "string", "description": "Filter by actor." },
            "target": { "type": "string", "description": "Filter by target." },
            "removed": { "type": "string", "description": "x" },''',
        expects=[],
        note="surrogate: probes whether an EXTRA field is caught",
    ),
    Mutation(
        name="case_type-enum-drops-a-variant",
        old='''            "case_type": {
                "type": "string",
                "enum": [
                    "nominative", "genitive", "dative", "accusative",
                    "instrumental", "locative", "ablative", "vocative"
                ],
                "description": "Filter by case entry type."
            },''',
        new='''            "case_type": {
                "type": "string",
                "enum": [
                    "nominative", "genitive", "dative", "accusative",
                    "instrumental", "ablative", "vocative"
                ],
                "description": "Filter by case entry type."
            },''',
        expects=["case_query_schema_matches_the_case_query_struct"],
        note="schema would reject vocative, which serde accepts",
    ),
    Mutation(
        name="case_type-enum-invents-a-variant",
        old='''            "case_type": {
                "type": "string",
                "enum": [
                    "nominative", "genitive", "dative", "accusative",
                    "instrumental", "locative", "ablative", "vocative"
                ],
                "description": "Filter by case entry type."
            },''',
        new='''            "case_type": {
                "type": "string",
                "enum": [
                    "nominative", "genitive", "dative", "accusative",
                    "instrumental", "locative", "ablative", "vocative", "sessive"
                ],
                "description": "Filter by case entry type."
            },''',
        expects=["case_query_schema_matches_the_case_query_struct"],
        note="a promise the runtime cannot keep",
    ),
    Mutation(
        name="case-append-tags-becomes-object",
        old='''            "tags": {
                "type": "array",
                "items": { "type": "string" },
                "description": "Tags. Bare JSON array — never {\\"item\\": [...]}.",
                "examples": [["instance-council-response", "collective"]]
            }''',
        new='''            "tags": { "type": "object", "description": "Tags." }''',
        expects=[
            "case_append_schema_types_tags_as_a_bare_array",
            "undescribed_shape_walk_detects_the_defects_it_claims_to",
        ],
        note="6 historical case_append calls wrapped tags this way",
    ),
    Mutation(
        name="case-append-tags-drops-items",
        old='''            "tags": {
                "type": "array",
                "items": { "type": "string" },''',
        new='''            "tags": {
                "type": "array",''',
        expects=["tool_schemas_declare_no_array_without_items"],
        note="array without element type",
    ),
    Mutation(
        name="case-append-offers-an-item-key",
        old='''            "action_kind": { "type": "string", "description": "Action label (bookkeeping)." },''',
        new='''            "action_kind": { "type": "string", "description": "Action label (bookkeeping)." },
            "item": { "type": "string", "description": "legacy" },''',
        expects=["case_append_schema_types_tags_as_a_bare_array"],
        note="offers the wrapper key",
    ),
    Mutation(
        name="soul-write-description-drops-the-rule",
        old='''            description: "Update soul memory. Arrays must be bare JSON arrays, never objects wrapping an array.".to_string(),''',
        new='''            description: "Update soul memory".to_string(),''',
        expects=["list_bearing_tools_mention_the_bare_array_rule_in_their_description"],
        note="the first thing the model reads no longer carries the rule",
    ),
    Mutation(
        name="guard-ignores-bare-objects",
        old='''                if node.get("properties").is_none()
                    && node.get("additionalProperties").is_none()
                    && path.contains(".properties") =>''',
        new='''                if node.get("properties").is_none()
                    && node.get("additionalProperties").is_none()
                    && false =>''',
        expects=["tool_schemas_declare_no_array_without_items"],
        note="NEUTRALISES the guard: the class of test that defends itself",
    ),
    Mutation(
        name="guard-ignores-arrays",
        old='''            Some("array") if node.get("items").is_none() => found
                .push(format!("{path}: array without items")),''',
        new='''            Some("array") if false => found
                .push(format!("{path}: array without items")),''',
        expects=["tool_schemas_declare_no_array_without_items"],
        note="NEUTRALISES the array half of the guard",
    ),
    Mutation(
        name="guard-stops-descending",
        old='''        if let Some(map) = node.as_object() {
            for (key, child) in map {
                undescribed_shape_nodes(child, &format!("{path}.{key}"), found);
            }
        }''',
        new='''        if let Some(map) = node.as_object() {
            for (key, child) in map.iter().take(0) {
                undescribed_shape_nodes(child, &format!("{path}.{key}"), found);
            }
        }''',
        expects=["tool_schemas_declare_no_array_without_items"],
        note="NEUTRALISES the guard by never visiting children",
    ),
]


def run_suite(filter_expr: str) -> tuple[int, list[str], str]:
    cmd = CARGO + (["--", filter_expr] if filter_expr else [])
    proc = subprocess.run(
        cmd, cwd=REPO, capture_output=True, text=True, timeout=900
    )
    out = proc.stdout + proc.stderr
    failed: list[str] = []
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("test ") and (" ... FAILED" in line or line.endswith("FAILED")):
            failed.append(line[5:].split(" ... ")[0].strip())
    m = re.search(r"test result: \w+\. (\d+) passed; (\d+) failed", out)
    passed = int(m.group(1)) if m else 0
    return passed, failed, out


def restore(original: str) -> None:
    """Put chat.rs back AND make sure cargo rebuilds it.

    `shutil.copy2` preserves mtime. That is fatal here: cargo fingerprints
    sources by mtime, so restoring a file with the mtime it had BEFORE the
    mutant build makes cargo believe nothing changed and keep the binary it
    just built FROM THE MUTANT. The source on disk then reads clean while
    the test binary still contains a neutered guard.

    This is not hypothetical. It is exactly what happened: the guard was
    reported as "detects nothing" (found == []) with byte-identical source
    to the passing run, and adding a debug print made it pass again -
    because the print changed the mtime and forced a rebuild.

    So: write the content, then stamp the current time.
    """
    TARGET.write_text(original)
    os.utime(TARGET, None)


def apply(source: str, mutation: Mutation) -> str:
    if source.count(mutation.old) == 0:
        raise SystemExit(f"anchor not found for mutation {mutation.name!r}")
    return source.replace(mutation.old, mutation.new, 1)


def main() -> int:
    full = "--full" in sys.argv
    as_json = "--json" in sys.argv
    only = next((a for a in sys.argv[1:] if not a.startswith("-")), None)
    filter_expr = "" if full else SCHEMA_FILTER

    original = TARGET.read_text()
    shutil.copy2(TARGET, BACKUP)
    if not original.strip():
        print("ABORT: chat.rs is empty")
        return 1

    print(f"target : {TARGET.relative_to(REPO)}")
    print(f"filter : {filter_expr or '(all lib tests)'}")
    print(f"mutations: {len(MUTATIONS)}\n")

    try:
        passed, failed, _ = run_suite(filter_expr)
        print(f"BASELINE: {passed} passed, {len(failed)} failed\n")
        baseline_passing = passed
        if passed < BASELINE_MIN:
            print(
                f"ABORT: baseline ran only {passed} tests, expected >= {BASELINE_MIN}.\n"
                f"A filter that matches nothing makes every mutant look like it\n"
                f"survived. Fix the filter before trusting any result."
            )
            return 1
        if failed:
            print("baseline is not green - fix that before reading mutant results:")
            for name in failed:
                print(f"  {name}")
            return 1

        results = []
        for mutation in MUTATIONS:
            if only and only not in mutation.name:
                continue
            TARGET.write_text(apply(original, mutation))
            os.utime(TARGET, None)
            t0 = time.time()
            try:
                _, failed, out = run_suite(filter_expr)
                compile_fail = "error[E0" in out or "error: could not compile" in out
            except subprocess.TimeoutExpired:
                failed, compile_fail = ["<timeout>"], True
            restore(original)
            elapsed = time.time() - t0

            killed = bool(failed)
            expected_kill = bool(mutation.expects)
            if compile_fail:
                verdict = "COMPILE-FAIL (invalid mutant)"
                killed = False
            elif killed and expected_kill:
                verdict = "KILLED"
            elif killed:
                verdict = "KILLED (unexpected test)"
            elif expected_kill:
                verdict = "SURVIVED  <-- gap"
            else:
                verdict = "survived (neutral)"

            results.append(
                {
                    "mutation": mutation.name,
                    "verdict": verdict,
                    "killed_by": failed,
                    "expected": mutation.expects,
                    "note": mutation.note,
                    "seconds": round(elapsed, 1),
                }
            )
            flag = "x" if killed else " "
            print(f"[{flag}] {mutation.name:<40} {verdict}")
            if killed:
                for name in failed[:6]:
                    print(f"        {name}")
            if not killed and expected_kill:
                print(f"        should have died: {', '.join(mutation.expects)}")
            if mutation.note:
                print(f"        # {mutation.note}")
    finally:
        restore(original)
        assert TARGET.read_text() == original, "restore was not byte-exact"
        print("\nrestored original chat.rs (verified byte-exact)")

    killed = [r for r in results if r["verdict"].startswith("KILLED")]
    survived = [r for r in results if r["verdict"].startswith("SURVIVED")]
    invalid = [r for r in results if r["verdict"].startswith("COMPILE-FAIL")]
    neutral = [r for r in results if r["verdict"] == "survived (neutral)"]

    print(f"\n{'=' * 64}")
    print(f"baseline passing tests : {baseline_passing}")
    print(f"killed                 : {len(killed)}")
    print(f"survived (GAPS)        : {len(survived)}")
    print(f"compile-fail (invalid) : {len(invalid)}")
    print(f"neutral mutants        : {len(neutral)}")
    for r in survived:
        print(f"  GAP  {r['mutation']}: {r['note']}")
    for r in invalid:
        print(f"  BAD  {r['mutation']}: not a real mutant")
    print("=" * 64)

    if as_json:
        print(json.dumps(results, indent=2))

    return 1 if (survived or invalid) else 0


if __name__ == "__main__":
    raise SystemExit(main())
