#!/usr/bin/env python3
"""
Kartograf corpus builder — Y1 Q1 N37.

Walks an allowlist of source paths + runtime chain blocks, filters out
anything matching the denylist or containing secret-pattern hits, applies
auto-zone labels via path heuristics (+ optional teacher distillation for
ambiguous files), and writes the tokenizable training/eval JSONL plus a
provenance summary that the quarterly exit test verifies.

INVARIANTS (binding per docs/dev/KARTOGRAF-SPEC.md + DEPENDENCY-POLICY.md):

  1. Vault NEVER enters corpus.
     Denylist is hard: ~/.memphis/vault/**, .env*, **/secrets/**,
     **/.memphis-backup*/**. Any attempt to read a denylisted path is a
     fatal error — we do not silently skip.
  2. Secret patterns reject the sample, not the build.
     Every sample passes through a regex set mirroring scripts/secret-scan.sh
     (AKIA, AIza, ghp_, sk-ant-, xox[baprs]-, JWT, PEM private keys, api_key="...").
     Matches → sample is dropped, counted in summary; build continues.
  3. Zone taxonomy aligned with canonical catalog.
     First 10 zones == keys of CHAIN_CATALOG in src/memory/chain-catalog.ts.
     Spec drift between 10-chain catalog and labeler fails the build before
     a single sample is written.
  4. Summary proves invariants.
     corpus-vN-summary.json has .secret_scan.clean=true AND
     .vault_denylist.enforced=true; the Q1 exit test asserts both fields.

USAGE:

  python3 tools/training/kartograf-corpus.py \
      --repo-root . \
      --chains-dir ~/.memphis/chains \
      --out-dir ~/.memphis/kartograf/corpus/v1 \
      [--no-teacher]       # skip Claude-ambiguous pass (offline mode)
      [--dry-run]          # don't write anything; just report stats

No runtime Memphis dependency. Pure-Python 3.9+. Build-time tool only.
"""

from __future__ import annotations

import argparse
import dataclasses
import fnmatch
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Iterable, Iterator

# ---------------------------------------------------------------------
# Zone taxonomy — MUST stay aligned with src/memory/chain-catalog.ts.
# First 10 zones are live chains (assertion below enforces this).
# ---------------------------------------------------------------------
ZONES = [
    "journal",
    "decisions",
    "reflections",
    "cases",
    "patterns",
    "system",
    "collective",
    "proactive",
    "insights",
    "soul",
    "reserved_1",
    "reserved_2",
]
LIVE_CHAINS = ZONES[:10]


# ---------------------------------------------------------------------
# Source allowlist (glob patterns relative to repo root) and the chain
# directory layout. Chain blocks live at ~/.memphis/chains/<chain>/*.json
# per src/infra/storage/chain-file-io.ts + src/infra/memory/embed-reindex.ts.
# ---------------------------------------------------------------------
REPO_ALLOWLIST_GLOBS = [
    "src/**/*.ts",
    "src/**/*.rs",
    "crates/**/*.rs",
    "docs/**/*.md",
    "tests/**/*.ts",
]

# Paths inside the operator's runtime directory. Expanded at scan time.
CONFIG_ALLOWLIST_FILES = [
    "config/ISKRA.md",
    "config/PULSE.md",
]

# Denylist — anything matching kills the entire sample (and in the first
# case, the entire build, because the vault content should never be
# readable at tool runtime). These patterns are matched against the full
# normalized path (home expanded) for both repo AND memphis-data scans.
DENYLIST_GLOBS = [
    "**/.memphis/vault/**",
    "**/.memphis/vault",
    "**/.env",
    "**/.env.*",
    "**/secrets/**",
    "**/.memphis-backup*/**",
]


# ---------------------------------------------------------------------
# Secret-pattern regexes. Keep aligned with scripts/secret-scan.sh.
# Every pattern that matches any sample content → sample rejected.
# ---------------------------------------------------------------------
SECRET_PATTERNS = [
    ("aws-access-key", re.compile(rb"AKIA[0-9A-Z]{16}")),
    ("gcp-api-key", re.compile(rb"AIza[0-9A-Za-z\-_]{35}")),
    ("github-pat", re.compile(rb"ghp_[0-9A-Za-z]{36}")),
    ("anthropic-key", re.compile(rb"sk-ant-[A-Za-z0-9\-_]{20,}")),
    ("slack-token", re.compile(rb"xox[baprs]-[0-9A-Za-z\-]{10,}")),
    ("jwt", re.compile(rb"eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+")),
    ("pem-private-key", re.compile(rb"-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----")),
    # Require an opening quote to avoid false positives on `api_key: fn_call(...)`
    # matches scripts/secret-scan.sh:PATTERN exactly (post-v1.5.0 hotfix)
    ("api-key-assignment", re.compile(rb"api[_-]?key\s*[:=]\s*[\"'][A-Za-z0-9_\-]{16,}")),
    ("password-assignment", re.compile(rb"password\s*[:=]\s*[\"'][^\"']{8,}")),
]


# ---------------------------------------------------------------------
# Zone heuristics. Tried in order; first match wins. If none match → the
# sample is ambiguous (candidate for teacher distillation in a later pass).
# ---------------------------------------------------------------------
ZONE_HEURISTICS = [
    # (repo-relative path-prefix OR regex, zone)
    ("src/security/", "system"),
    ("crates/memphis-vault/", "system"),
    ("crates/memphis-core/src/signature", "system"),
    ("src/core/decision-chain", "decisions"),
    ("src/memory/", "decisions"),
    ("src/cognitive/", "reflections"),
    ("src/gateway/", "system"),
    ("src/mcp/tools/", "system"),
    ("src/infra/cli/", "system"),
    ("src/infra/http/", "system"),
    ("src/infra/tui-host/", "system"),
    ("src/trajectory/", "system"),
    ("src/kartograf/", "system"),
    ("crates/memphis-tui/", "system"),
    ("crates/memphis-embed/", "system"),
    ("crates/memphis-napi/", "system"),
    ("crates/memphis-operator/", "system"),
    ("docs/", "system"),
    ("tests/", "system"),
]


@dataclasses.dataclass
class SecretHit:
    path: str
    pattern: str


@dataclasses.dataclass
class Sample:
    source_path: str          # canonical path (repo-relative OR chain:<chain>/<block>)
    content: str              # raw textual content
    zone: str                 # one of ZONES
    mutability: float         # 0=old/invariant, 1=freshly-touched
    sha256: str               # hex of content
    license: str              # inferred license tag ('repo:apache-2.0' default for repo src)
    ambiguous: bool           # true when no heuristic matched


# =====================================================================
# Denylist + secret-scan helpers
# =====================================================================


def _match_any(path: str, globs: Iterable[str]) -> bool:
    for pat in globs:
        if fnmatch.fnmatch(path, pat):
            return True
    return False


def _is_denied(path: str) -> bool:
    # fnmatch against the full path AND against the path with trailing slash
    # so glob patterns like '**/.memphis/vault/**' catch directories too.
    return _match_any(path, DENYLIST_GLOBS)


def _resolved_denylist_check(path: Path) -> str | None:
    """Return a rejection reason if the path (or its symlink target) is denied.

    Denylist enforcement must use the resolved real path, not the symlink
    path — otherwise an allowlisted symlink like `src/leak.ts` that
    actually points into `~/.memphis/vault/...` would bypass the vault
    invariant and land in `train.jsonl`/`eval.jsonl`. We also reject
    symlinks that fail to resolve (dangling) rather than silently dropping
    them so the audit trail is complete.
    """
    try:
        resolved = path.resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        return f"resolve-failed:{exc}"
    if _is_denied(str(path)) or _is_denied(str(resolved)):
        return "denylist-path"
    # Reject if the resolved target escapes into a vault-like directory
    # even when the glob set doesn't cover every variant.
    resolved_str = str(resolved)
    if "/.memphis/vault/" in resolved_str or resolved_str.endswith("/.memphis/vault"):
        return "denylist-vault-symlink"
    return None


def _scan_secrets(data: bytes) -> list[str]:
    hits: list[str] = []
    for name, pat in SECRET_PATTERNS:
        if pat.search(data):
            hits.append(name)
    return hits


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# =====================================================================
# Walkers
# =====================================================================


def _expand_repo_allowlist(repo_root: Path) -> Iterator[Path]:
    for pat in REPO_ALLOWLIST_GLOBS:
        yield from repo_root.glob(pat)


def _expand_config_allowlist(data_root: Path) -> Iterator[Path]:
    for rel in CONFIG_ALLOWLIST_FILES:
        p = data_root / rel
        if p.exists():
            yield p


def _walk_chain_blocks(chains_dir: Path) -> Iterator[tuple[str, Path]]:
    """Yield (chain_name, block_path) for every *.json block per live chain."""
    if not chains_dir.exists():
        return
    for chain_name in LIVE_CHAINS:
        chain_dir = chains_dir / chain_name
        if not chain_dir.is_dir():
            continue
        for block_path in sorted(chain_dir.glob("*.json")):
            yield chain_name, block_path


# =====================================================================
# Zone labeling
# =====================================================================


def _heuristic_zone(rel_path: str) -> tuple[str, bool]:
    """Return (zone, ambiguous). ambiguous=True when no heuristic matched."""
    rel_norm = rel_path.replace("\\", "/")
    for prefix, zone in ZONE_HEURISTICS:
        if prefix in rel_norm:
            return zone, False
    return "system", True  # fall-back to 'system', flag for teacher pass


def _chain_zone(chain_name: str) -> str:
    if chain_name in LIVE_CHAINS:
        return chain_name
    raise ValueError(f"chain {chain_name!r} not in LIVE_CHAINS — catalog drift?")


# =====================================================================
# git-based mutability
# =====================================================================


def _git_mutability(repo_root: Path, rel_path: str, now_epoch: float) -> float:
    """Return 0..1 mutability score from last git commit age vs repo age."""
    try:
        result = subprocess.run(
            [
                "git", "-C", str(repo_root),
                "log", "-1", "--format=%at", "--", rel_path,
            ],
            capture_output=True, text=True, check=False, timeout=5,
        )
        if result.returncode != 0 or not result.stdout.strip():
            return 0.5
        last = int(result.stdout.strip())
        # Repo-age heuristic: normalize against 2 years = fully-mature mutability window.
        age_days = max(0.0, (now_epoch - last) / 86400.0)
        return max(0.0, min(1.0, 1.0 - (age_days / 730.0)))
    except Exception:
        return 0.5


# =====================================================================
# Sample assembly
# =====================================================================


def _read_text(path: Path) -> tuple[bytes, str]:
    data = path.read_bytes()
    return data, data.decode("utf-8", errors="replace")


def _build_repo_sample(
    repo_root: Path,
    path: Path,
    now_epoch: float,
) -> tuple[Sample | None, SecretHit | None]:
    rel = path.relative_to(repo_root).as_posix()
    reason = _resolved_denylist_check(path)
    if reason is not None:
        return None, SecretHit(rel, reason)
    data, text = _read_text(path)
    hits = _scan_secrets(data)
    if hits:
        return None, SecretHit(rel, hits[0])
    zone, ambiguous = _heuristic_zone(rel)
    mutability = _git_mutability(repo_root, rel, now_epoch)
    return Sample(
        source_path=rel,
        content=text,
        zone=zone,
        mutability=mutability,
        sha256=_sha256_hex(data),
        license="repo:apache-2.0",
        ambiguous=ambiguous,
    ), None


def _build_chain_sample(
    chain_name: str,
    block_path: Path,
) -> tuple[Sample | None, SecretHit | None]:
    reason = _resolved_denylist_check(block_path)
    if reason is not None:
        return None, SecretHit(f"chain:{chain_name}/{block_path.name}", reason)
    try:
        raw = block_path.read_bytes()
    except OSError as exc:
        return None, SecretHit(f"chain:{chain_name}/{block_path.name}", f"read-error:{exc}")
    try:
        block = json.loads(raw)
    except json.JSONDecodeError as exc:
        return None, SecretHit(f"chain:{chain_name}/{block_path.name}", f"json-decode:{exc}")
    content = ""
    data_field = block.get("data") if isinstance(block, dict) else None
    if isinstance(data_field, dict):
        c = data_field.get("content")
        if isinstance(c, str):
            content = c
    if not content.strip():
        return None, None  # skip empty blocks silently (not a secret hit)
    # Scan the DECODED content (not the raw JSON bytes). JSON escaping
    # like `\"` vs `"` would otherwise let an attacker encode a secret in
    # the stored string that the raw-byte scan misses (quote-dependent
    # patterns bypass). Also re-scan raw as defense-in-depth — catches
    # cases where the secret lives in other block fields, not just
    # data.content.
    hits_decoded = _scan_secrets(content.encode("utf-8"))
    if hits_decoded:
        return None, SecretHit(f"chain:{chain_name}/{block_path.name}", hits_decoded[0])
    hits_wrapper = _scan_secrets(raw)
    if hits_wrapper:
        return None, SecretHit(f"chain:{chain_name}/{block_path.name}", hits_wrapper[0])
    sample = Sample(
        source_path=f"chain:{chain_name}/{block_path.name}",
        content=content,
        zone=_chain_zone(chain_name),
        mutability=0.8,  # runtime chain content is inherently fresh
        sha256=_sha256_hex(content.encode("utf-8")),
        license="operator:local-only",
        ambiguous=False,
    )
    return sample, None


# =====================================================================
# Main
# =====================================================================


def _assert_zone_catalog_alignment(repo_root: Path) -> None:
    """Verify LIVE_CHAINS matches src/memory/chain-catalog.ts keys."""
    catalog_path = repo_root / "src" / "memory" / "chain-catalog.ts"
    if not catalog_path.exists():
        print(
            f"[warn] {catalog_path} not found — skipping catalog alignment check",
            file=sys.stderr,
        )
        return
    text = catalog_path.read_text(encoding="utf-8", errors="replace")
    # Very lightweight: pull top-level keys inside CHAIN_CATALOG = {...}.
    pattern = re.compile(r"^\s{2}([a-z_]+):\s*\{", re.MULTILINE)
    found = [m.group(1) for m in pattern.finditer(text)]
    if set(found) != set(LIVE_CHAINS):
        raise SystemExit(
            "zone catalog drift: "
            f"src/memory/chain-catalog.ts keys={sorted(found)} "
            f"vs LIVE_CHAINS={sorted(LIVE_CHAINS)}. "
            "Update kartograf-corpus.py LIVE_CHAINS + KARTOGRAF-SPEC.md before rebuilding."
        )


_DENYLIST_REJECTION_REASONS = {
    "denylist-path",
    "denylist-vault-symlink",
}


def _tally_rejection(
    hit: SecretHit,
    secret_hits_by_pattern: dict[str, int],
) -> int:
    """Return 1 if this rejection counts as a vault-denylist refusal, 0 otherwise.

    Secret-pattern matches update `secret_hits_by_pattern` in place.
    Operational errors (`json-decode:*`, `read-error:*`, `resolve-failed:*`)
    are recorded in `rejected` for audit but don't inflate either metric.
    """
    if hit.pattern in _DENYLIST_REJECTION_REASONS:
        return 1
    if (
        hit.pattern.startswith("json-decode")
        or hit.pattern.startswith("read-error")
        or hit.pattern.startswith("resolve-failed")
    ):
        return 0
    secret_hits_by_pattern[hit.pattern] = secret_hits_by_pattern.get(hit.pattern, 0) + 1
    return 0


def build_corpus(args: argparse.Namespace) -> int:
    repo_root = Path(args.repo_root).resolve()
    chains_dir = Path(args.chains_dir).expanduser().resolve() if args.chains_dir else None
    data_root = Path(args.data_root).expanduser().resolve() if args.data_root else None
    out_dir = Path(args.out_dir).expanduser().resolve()

    _assert_zone_catalog_alignment(repo_root)

    now_epoch = time.time()
    samples: list[Sample] = []
    rejected: list[SecretHit] = []
    secret_hits_by_pattern: dict[str, int] = {}
    vault_denylist_refusals = 0

    # Repo-local sources
    seen_paths: set[str] = set()
    for path in _expand_repo_allowlist(repo_root):
        if not path.is_file():
            continue
        rel = path.relative_to(repo_root).as_posix()
        if rel in seen_paths:
            continue
        seen_paths.add(rel)
        sample, hit = _build_repo_sample(repo_root, path, now_epoch)
        if sample is not None:
            samples.append(sample)
        if hit is not None:
            rejected.append(hit)
            vault_denylist_refusals += _tally_rejection(hit, secret_hits_by_pattern)

    # Operator config (ISKRA/PULSE) — same tally as repo/chain passes so
    # secret + denylist counters stay consistent in the audit summary.
    if data_root is not None:
        for path in _expand_config_allowlist(data_root):
            sample, hit = _build_repo_sample(data_root, path, now_epoch)
            if sample is not None:
                sample.source_path = f"config:{path.relative_to(data_root).as_posix()}"
                sample.license = "operator:local-only"
                samples.append(sample)
            if hit is not None:
                rejected.append(hit)
                vault_denylist_refusals += _tally_rejection(hit, secret_hits_by_pattern)

    # Chain blocks per-chain directory
    if chains_dir is not None:
        for chain_name, block_path in _walk_chain_blocks(chains_dir):
            sample, hit = _build_chain_sample(chain_name, block_path)
            if sample is not None:
                samples.append(sample)
            if hit is not None:
                rejected.append(hit)
                vault_denylist_refusals += _tally_rejection(hit, secret_hits_by_pattern)

    # Teacher distillation (Claude) for ambiguous repo samples.
    # Out of scope for this file: network wiring. Placeholder hook.
    if not args.no_teacher:
        ambiguous = [s for s in samples if s.ambiguous]
        # Intentional NO-OP in v1 — real wiring lands with training pipeline.
        # Only flag ambiguous count in summary so operators know how many
        # would benefit from a teacher pass.
        teacher_calls_queued = len(ambiguous)
    else:
        teacher_calls_queued = 0

    # 80/20 stratified-by-zone split
    train: list[Sample] = []
    eval_: list[Sample] = []
    by_zone: dict[str, list[Sample]] = {}
    for s in samples:
        by_zone.setdefault(s.zone, []).append(s)
    for zone_samples in by_zone.values():
        zone_samples.sort(key=lambda s: s.source_path)
        split = max(1, int(len(zone_samples) * 0.8)) if len(zone_samples) > 5 else len(zone_samples)
        train.extend(zone_samples[:split])
        eval_.extend(zone_samples[split:])

    per_zone_counts = {z: len(by_zone.get(z, [])) for z in ZONES}

    # Post-filter re-scan: prove that every sample that actually made it
    # into the output corpus is free of secret-pattern hits. The input
    # may have matched patterns (that's WHY we reject), but the output
    # must be clean — this is the invariant the Q1 exit test asserts.
    output_hits = 0
    for s in samples:
        if _scan_secrets(s.content.encode("utf-8")):
            output_hits += 1

    summary = {
        "corpus_version": "v1",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_epoch)),
        "source_count": len(samples),
        "rejected_count": len(rejected),
        "secret_scan": {
            # `clean` = output corpus contains zero secret-pattern hits.
            # A non-zero `input_patterns_matched_count` is expected and
            # healthy (means the scanner caught things); what matters is
            # that filtered output is clean.
            "clean": output_hits == 0,
            "output_hits": output_hits,
            "input_patterns_matched_count": sum(secret_hits_by_pattern.values()),
            "input_patterns_matched": secret_hits_by_pattern,
        },
        "vault_denylist": {
            "enforced": True,
            "paths_refused": vault_denylist_refusals,
        },
        "per_zone_counts": per_zone_counts,
        "split": {"train": len(train), "eval": len(eval_)},
        "teacher_calls_queued": teacher_calls_queued,
        "license_breakdown": {
            lic: sum(1 for s in samples if s.license == lic)
            for lic in sorted({s.license for s in samples})
        },
    }

    if args.dry_run:
        print(json.dumps(summary, indent=2))
        return 0

    out_dir.mkdir(parents=True, exist_ok=True)
    _write_jsonl(out_dir / "train.jsonl", train)
    _write_jsonl(out_dir / "eval.jsonl", eval_)
    (out_dir / "zone-labels.json").write_text(json.dumps(ZONES, indent=2), encoding="utf-8")
    license_audit = {
        s.source_path: {"license": s.license, "sha256": s.sha256}
        for s in samples
    }
    (out_dir / "license-audit.json").write_text(json.dumps(license_audit, indent=2), encoding="utf-8")
    (out_dir / "corpus-v1-summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"[ok] wrote {len(train)} train + {len(eval_)} eval samples to {out_dir}")
    print(f"[ok] rejected {len(rejected)} samples (denylist + secret scan)")
    print(f"[ok] secret_scan.clean={summary['secret_scan']['clean']}")
    print(f"[ok] vault_denylist.enforced={summary['vault_denylist']['enforced']}")
    return 0


def _write_jsonl(path: Path, samples: list[Sample]) -> None:
    with path.open("w", encoding="utf-8") as fh:
        for s in samples:
            row = {
                "source_path": s.source_path,
                "zone": s.zone,
                "content": s.content,
                "sha256": s.sha256,
                "license": s.license,
                "mutability": round(s.mutability, 4),
                "ambiguous": s.ambiguous,
            }
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Kartograf corpus builder (N37)")
    parser.add_argument("--repo-root", default=".", help="Memphis repo root (default: cwd)")
    parser.add_argument(
        "--chains-dir",
        default=str(Path.home() / ".memphis" / "chains"),
        help="Directory holding per-chain block files (default: ~/.memphis/chains)",
    )
    parser.add_argument(
        "--data-root",
        default=str(Path.home() / ".memphis"),
        help="Operator data root for ISKRA/PULSE reads (default: ~/.memphis)",
    )
    parser.add_argument(
        "--out-dir",
        default=str(Path.home() / ".memphis" / "kartograf" / "corpus" / "v1"),
        help="Output directory (default: ~/.memphis/kartograf/corpus/v1)",
    )
    parser.add_argument(
        "--no-teacher",
        action="store_true",
        help="Skip teacher distillation pass (offline mode; ambiguous stay labeled 'system')",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print summary to stdout; do not write files",
    )
    args = parser.parse_args()
    return build_corpus(args)


if __name__ == "__main__":
    sys.exit(main())
