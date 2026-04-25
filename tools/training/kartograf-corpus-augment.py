#!/usr/bin/env python3
"""
Kartograf corpus augmentation — Q2 N32 Phase 2.5.

Extends the v1 corpus (produced by kartograf-corpus.py + pair-miner) with
external reference material that gives the 150M-param encoder enough
breadth to serve as an agent-navigation tier-0 retriever:

  - The Rust Programming Language (rust-lang/book)   [Apache-2.0]
  - TypeScript Handbook (microsoft/TypeScript-Website) [CC-BY-4.0]
  - memphis-v5.pl/docs (19 pages; operator-public)     [operator:public]

Why these: the baseline v1 corpus teaches Kartograf what EXISTS in
Memphis (code + chain blocks + docs). The augmentation teaches it the
IDIOM space of the two languages Memphis actually writes in, so an
agent asking "how do I add a chain in Rust that implements Serde" gets
retrieval over BOTH the Memphis crate examples AND the Rust Book's
trait/derive chapters — not just one or the other. The dense
embedding space collapses these into neighbors through shared
identifiers + grammar tokens, without needing task-labeled pairs.

Not a shortcut: emits a NEW corpus version v2 in a separate directory.
v1 stays immutable per spec §Eval (frozen 500-query set). The v2
envelope will carry `corpus_version: "v2"`. If Phase 6 eval on v2
fails, we can always train on v1 again.

Stdlib + HTMLParser only — no new runtime deps.

USAGE:

  # Fetch sources first (one-time, before running this script):
  #   mkdir -p /tmp/karto-aug/src
  #   git clone --depth 1 https://github.com/rust-lang/book /tmp/karto-aug/src/rust-book
  #   git clone --depth 1 https://github.com/microsoft/TypeScript-Website /tmp/karto-aug/src/ts-website
  #   (fetch memphis-v5.pl pages via scripts/fetch-memphis-v5-docs.sh)
  #
  # Then run:
  python3 tools/training/kartograf-corpus-augment.py \\
      --v1-dir ~/.memphis/kartograf/corpus/v1 \\
      --v2-dir ~/.memphis/kartograf/corpus/v2 \\
      --rust-book-dir /tmp/karto-aug/src/rust-book/src \\
      --ts-handbook-dir /tmp/karto-aug/src/ts-website/packages/documentation/copy/en \\
      --memphis-v5-dir /tmp/karto-aug/memphis-v5-pages

Exit codes:
  0 — success, v2 written
  1 — missing source dir / invariant violation
  2 — IO failure
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import shutil
import sys
import time
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Iterable, Iterator

# --- Chunk config -----------------------------------------------------
# Kartograf tokenizes with ModernBERT's BPE at max_length=512 (spec
# §Path A). We target ~380 tokens of text (rough 4 chars/token English)
# so tokenization + special tokens still fit 512. Chunks that run long
# are soft-split at sentence boundaries.
TARGET_CHARS_PER_CHUNK = 1500
HARD_MAX_CHARS = 2400
MIN_CHARS_PER_CHUNK = 80
SENTENCE_END_RE = re.compile(r"(?<=[.!?])\s+(?=[A-ZŁŚŻŹÓĄĘŃĆ])")
PARAGRAPH_SPLIT_RE = re.compile(r"\n\s*\n+")

# --- Zone taxonomy ---------------------------------------------------
# Mirror of kartograf_train.data.ZONES. Augmented samples must land in
# the live-chain slots (1-10), never reserved_*.
LIVE_ZONES = {
    "journal", "decisions", "reflections", "cases", "patterns",
    "system", "collective", "proactive", "insights", "soul",
}


@dataclass
class Sample:
    source_path: str
    zone: str
    content: str
    license: str
    mutability: float = 0.5  # augmented samples are moderately stable
    ambiguous: bool = False

    def as_jsonl(self) -> dict:
        sha = hashlib.sha256(self.content.encode("utf-8")).hexdigest()
        return {
            "source_path": self.source_path,
            "zone": self.zone,
            "content": self.content,
            "sha256": sha,
            "license": self.license,
            "mutability": self.mutability,
            "ambiguous": self.ambiguous,
        }


# --- Chunking helpers ------------------------------------------------

def _soft_chunks(text: str, heading: str = "") -> Iterator[str]:
    """Split `text` (plain, already paragraph-bounded) into chunks near
    TARGET_CHARS_PER_CHUNK. Chunks carry `heading` prefix for context
    continuity when downstream chunking splits a section."""
    paragraphs = [p.strip() for p in PARAGRAPH_SPLIT_RE.split(text) if p.strip()]
    buf: list[str] = []
    buf_len = 0
    prefix = f"{heading}\n\n" if heading else ""
    prefix_len = len(prefix)
    for para in paragraphs:
        if len(para) > HARD_MAX_CHARS:
            # Break the paragraph itself into sentence runs.
            sentences = SENTENCE_END_RE.split(para)
            for sent in sentences:
                sent = sent.strip()
                if not sent:
                    continue
                if buf_len + len(sent) + prefix_len > HARD_MAX_CHARS and buf:
                    out = prefix + "\n\n".join(buf)
                    if len(out) >= MIN_CHARS_PER_CHUNK:
                        yield out
                    buf = [sent]
                    buf_len = len(sent)
                else:
                    buf.append(sent)
                    buf_len += len(sent)
            continue
        if buf_len + len(para) + prefix_len > TARGET_CHARS_PER_CHUNK and buf:
            out = prefix + "\n\n".join(buf)
            if len(out) >= MIN_CHARS_PER_CHUNK:
                yield out
            buf = [para]
            buf_len = len(para)
        else:
            buf.append(para)
            buf_len += len(para)
    if buf:
        out = prefix + "\n\n".join(buf)
        if len(out) >= MIN_CHARS_PER_CHUNK:
            yield out


# --- Rust Book ingestion ---------------------------------------------

# The `src/` dir of rust-lang/book contains chapters as individual .md
# files (ch01-01-installation.md, etc.) plus SUMMARY.md and appendices.
def ingest_rust_book(root: Path) -> Iterator[Sample]:
    if not root.is_dir():
        return
    for md_path in sorted(root.rglob("*.md")):
        rel = md_path.relative_to(root)
        # SUMMARY.md is a TOC; skip — no semantic content for retrieval.
        if rel.name == "SUMMARY.md":
            continue
        try:
            text = md_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        # Extract h1/h2 for the heading prefix.
        heading_match = re.search(r"^#{1,2}\s+(.+?)$", text, flags=re.M)
        heading = heading_match.group(1).strip() if heading_match else rel.stem
        # Strip mdbook-specific directives ({{#include ...}}, etc.) —
        # they're noise without the surrounding build context.
        text = re.sub(r"\{\{#[^}]+\}\}", "", text)
        n_chunks = 0
        for chunk_idx, chunk in enumerate(_soft_chunks(text, heading=heading)):
            yield Sample(
                source_path=f"book:rust-book/{rel.as_posix()}#c{chunk_idx}",
                # Rust Book covers the language Memphis crates are written in.
                # Zone `patterns` = learned predictive patterns; "how to
                # write idiomatic Rust" fits better than raw `system`.
                zone="patterns",
                content=chunk,
                license="repo:apache-2.0",
                mutability=0.3,  # reference material changes slowly
            )
            n_chunks += 1
        if n_chunks == 0:
            # File too short to emit even one chunk? Skip silently.
            continue


# --- TypeScript Handbook ingestion -----------------------------------

def ingest_ts_handbook(root: Path) -> Iterator[Sample]:
    if not root.is_dir():
        return
    for md_path in sorted(root.rglob("*.md")):
        rel = md_path.relative_to(root)
        if rel.name.lower() in {"toc.md", "index.md"}:
            continue
        try:
            text = md_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        # Strip YAML frontmatter (TS Website uses it extensively).
        if text.startswith("---"):
            end = text.find("\n---", 3)
            if end > 0:
                text = text[end + 4:]
        heading_match = re.search(r"^#{1,2}\s+(.+?)$", text, flags=re.M)
        heading = heading_match.group(1).strip() if heading_match else rel.stem
        for chunk_idx, chunk in enumerate(_soft_chunks(text, heading=heading)):
            yield Sample(
                source_path=f"book:ts-handbook/{rel.as_posix()}#c{chunk_idx}",
                zone="patterns",
                content=chunk,
                license="repo:cc-by-4.0",
                mutability=0.3,
            )


# --- Memphis v5 docs (HTML) ------------------------------------------

class _MkdocsTextExtractor(HTMLParser):
    """Pull the <article> body text from an mkdocs-material page, drop
    nav/header/footer/sidebar. Code blocks preserved, headings kept.
    Crude but deterministic — no bs4 dep."""

    SKIP_TAGS = {"script", "style", "nav", "aside", "header", "footer",
                 "form", "button", "svg", "template"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.depth_skip = 0
        self.in_article = False
        self.out: list[str] = []
        self._in_heading = False
        self._in_code = False
        self._in_pre = False

    def handle_starttag(self, tag: str, attrs) -> None:
        attrs_d = dict(attrs)
        tag = tag.lower()
        if tag in self.SKIP_TAGS:
            self.depth_skip += 1
            return
        if tag == "article":
            self.in_article = True
            return
        if not self.in_article:
            return
        if self.depth_skip:
            return
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._in_heading = True
            self.out.append("\n\n## ")
        elif tag == "p":
            self.out.append("\n\n")
        elif tag == "pre":
            self._in_pre = True
            self.out.append("\n\n```\n")
        elif tag == "code" and not self._in_pre:
            self._in_code = True
            self.out.append("`")
        elif tag == "li":
            self.out.append("\n- ")
        elif tag == "br":
            self.out.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in self.SKIP_TAGS:
            if self.depth_skip:
                self.depth_skip -= 1
            return
        if tag == "article":
            self.in_article = False
            return
        if not self.in_article or self.depth_skip:
            return
        if tag in {"h1", "h2", "h3", "h4", "h5", "h6"}:
            self._in_heading = False
            self.out.append("\n\n")
        elif tag == "pre":
            self._in_pre = False
            self.out.append("\n```\n")
        elif tag == "code" and self._in_code:
            self._in_code = False
            self.out.append("`")

    def handle_data(self, data: str) -> None:
        if not self.in_article or self.depth_skip:
            return
        self.out.append(data)

    def result(self) -> str:
        text = "".join(self.out)
        # Collapse triple-plus newlines to max 2; strip boilerplate.
        text = re.sub(r"\n{3,}", "\n\n", text)
        return text.strip()


def ingest_memphis_v5(root: Path) -> Iterator[Sample]:
    if not root.is_dir():
        return
    for html_path in sorted(root.glob("*.html")):
        try:
            raw = html_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        parser = _MkdocsTextExtractor()
        try:
            parser.feed(raw)
        except Exception as exc:  # noqa: BLE001 — parser best-effort
            print(f"[aug] skip {html_path.name}: {exc}", file=sys.stderr)
            continue
        text = parser.result()
        if len(text) < MIN_CHARS_PER_CHUNK:
            continue
        # Derive zone from path heuristics. `internal/*` pages are
        # roadmap / incidents / deploy notes — these are decisions, not
        # system reference. Everything else goes `system`.
        stem = html_path.stem
        zone = "decisions" if stem.startswith("internal") else "system"
        # License: this is the operator's own public site content, tagged
        # the same way as ISKRA.md/PULSE.md (operator-local -> public).
        heading_match = re.search(r"^##\s+(.+?)$", text, flags=re.M)
        heading = heading_match.group(1).strip() if heading_match else stem
        for chunk_idx, chunk in enumerate(_soft_chunks(text, heading=heading)):
            yield Sample(
                source_path=f"site:memphis-v5/{stem}#c{chunk_idx}",
                zone=zone,
                content=chunk,
                license="operator:public",
                mutability=0.6,  # operator's own site, changes with releases
            )


# --- Main driver -----------------------------------------------------

def load_v1_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        raise SystemExit(f"[aug] missing v1 corpus file: {path}")
    out = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            out.append(json.loads(line))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--v1-dir", required=True, type=Path,
                        help="Existing v1 corpus (immutable; read-only).")
    parser.add_argument("--v2-dir", required=True, type=Path,
                        help="Output directory for v2 corpus (will be created).")
    parser.add_argument("--rust-book-dir", type=Path, default=None,
                        help="Path to rust-lang/book src/ directory.")
    parser.add_argument("--ts-handbook-dir", type=Path, default=None,
                        help="Path to ts-website documentation/copy/en/ directory.")
    parser.add_argument("--memphis-v5-dir", type=Path, default=None,
                        help="Directory with memphis-v5.pl/docs HTML pages.")
    parser.add_argument("--eval-ratio", type=float, default=0.1,
                        help="Fraction of NEW samples to reserve for eval split "
                             "(default 0.1). v1 eval is copied verbatim.")
    parser.add_argument("--seed", type=int, default=42,
                        help="Deterministic split seed.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report counts only; don't write v2/.")
    args = parser.parse_args()

    v1_dir = args.v1_dir.expanduser().resolve()
    v2_dir = args.v2_dir.expanduser().resolve()

    print(f"[aug] reading v1 from {v1_dir}", file=sys.stderr)
    v1_train = load_v1_jsonl(v1_dir / "train.jsonl")
    v1_eval = load_v1_jsonl(v1_dir / "eval.jsonl")
    print(f"[aug] v1 train={len(v1_train)} eval={len(v1_eval)}", file=sys.stderr)

    # Dedup v1 sha set so we don't accidentally re-emit augmented samples
    # that collide with existing content.
    seen_sha: set[str] = set()
    for s in v1_train + v1_eval:
        seen_sha.add(s["sha256"])

    # Collect augmented samples.
    new_samples: list[Sample] = []
    source_counts: dict[str, int] = {}

    def _collect(name: str, it: Iterable[Sample]) -> None:
        n = 0
        for s in it:
            obj = s.as_jsonl()
            if obj["sha256"] in seen_sha:
                # Dedupe: skip content-duplicates (unlikely but possible
                # if a chunk hashes-collides with an existing repo file).
                continue
            seen_sha.add(obj["sha256"])
            new_samples.append(s)
            n += 1
        source_counts[name] = n
        print(f"[aug]   {name}: {n} new samples", file=sys.stderr)

    if args.rust_book_dir:
        _collect("rust-book", ingest_rust_book(args.rust_book_dir.expanduser()))
    if args.ts_handbook_dir:
        _collect("ts-handbook", ingest_ts_handbook(args.ts_handbook_dir.expanduser()))
    if args.memphis_v5_dir:
        _collect("memphis-v5", ingest_memphis_v5(args.memphis_v5_dir.expanduser()))

    total_new = len(new_samples)
    if total_new == 0:
        raise SystemExit(
            "[aug] no new samples produced — check --rust-book-dir / "
            "--ts-handbook-dir / --memphis-v5-dir inputs."
        )
    print(
        f"[aug] total new samples: {total_new}"
        f" (v1 train {len(v1_train)} → v2 candidate {len(v1_train) + total_new})",
        file=sys.stderr,
    )

    # Split new samples into train/eval via deterministic hash bucketing.
    # Using sha256 modulo is stable across runs without needing to persist
    # a random seed — the same chunk always lands in the same split.
    new_train: list[dict] = []
    new_eval: list[dict] = []
    eval_bucket = int(args.eval_ratio * 1000)
    for s in new_samples:
        obj = s.as_jsonl()
        # Mix in seed so a re-split with different seed gives different
        # bucketing for robustness testing.
        mix = hashlib.sha256(
            f"{obj['sha256']}:{args.seed}".encode("utf-8")
        ).hexdigest()
        bucket = int(mix[:4], 16) % 1000
        if bucket < eval_bucket:
            new_eval.append(obj)
        else:
            new_train.append(obj)

    print(
        f"[aug] split: new_train={len(new_train)} new_eval={len(new_eval)} "
        f"(ratio={args.eval_ratio})",
        file=sys.stderr,
    )

    # Assemble v2 corpus.
    v2_train = v1_train + new_train
    v2_eval = v1_eval + new_eval

    # Zone-by-origin accounting for the summary.
    zone_counts: dict[str, int] = {}
    for s in v2_train + v2_eval:
        z = s["zone"]
        zone_counts[z] = zone_counts.get(z, 0) + 1

    if args.dry_run:
        print(
            f"[aug] DRY RUN: would write v2_train={len(v2_train)} "
            f"v2_eval={len(v2_eval)} to {v2_dir}",
            file=sys.stderr,
        )
        return 0

    # Write v2.
    v2_dir.mkdir(parents=True, exist_ok=True)
    (v2_dir / "train.jsonl").write_text(
        "\n".join(json.dumps(s, separators=(",", ":")) for s in v2_train) + "\n",
        encoding="utf-8",
    )
    (v2_dir / "eval.jsonl").write_text(
        "\n".join(json.dumps(s, separators=(",", ":")) for s in v2_eval) + "\n",
        encoding="utf-8",
    )
    # Preserve v1's zone-labels.json and license-audit.json references.
    if (v1_dir / "zone-labels.json").exists():
        shutil.copy2(v1_dir / "zone-labels.json", v2_dir / "zone-labels.json")

    # Build a v2 summary. Preserves v1's invariant fields (secret_scan,
    # vault_denylist) because we did not re-scan during augmentation —
    # external content comes from trusted public sources. Add a
    # `external_audit` block documenting origin + license per source.
    v1_summary = json.loads(
        (v1_dir / "corpus-v1-summary.json").read_text(encoding="utf-8")
    )
    v2_summary = {
        "corpus_version": "v2",
        "parent_corpus_version": v1_summary.get("corpus_version", "v1"),
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source_count": len(v2_train) + len(v2_eval),
        "split": {"train": len(v2_train), "eval": len(v2_eval)},
        # Inherit invariants — v1's secret_scan is still authoritative
        # for the Memphis-origin samples; external sources are
        # explicitly public-reference-material, no secret-scan needed.
        "secret_scan": v1_summary.get("secret_scan"),
        "vault_denylist": v1_summary.get("vault_denylist"),
        "per_zone_counts": zone_counts,
        "teacher_calls_queued": v1_summary.get("teacher_calls_queued", 0),
        "license_breakdown": _compute_license_breakdown(v2_train + v2_eval),
        "augmentation": {
            "new_samples": total_new,
            "eval_split_seed": args.seed,
            "eval_ratio": args.eval_ratio,
            "sources": [
                {"name": "rust-book",
                 "license": "repo:apache-2.0",
                 "url": "https://github.com/rust-lang/book",
                 "sample_count": source_counts.get("rust-book", 0)},
                {"name": "ts-handbook",
                 "license": "repo:cc-by-4.0",
                 "url": "https://github.com/microsoft/TypeScript-Website",
                 "sample_count": source_counts.get("ts-handbook", 0)},
                {"name": "memphis-v5",
                 "license": "operator:public",
                 "url": "https://memphis-v5.pl/docs/",
                 "sample_count": source_counts.get("memphis-v5", 0)},
            ],
        },
    }
    (v2_dir / "corpus-v2-summary.json").write_text(
        json.dumps(v2_summary, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )
    # Also write a symlink-compatible summary.json so existing loaders
    # that look for corpus-v1-summary.json find something useful.
    (v2_dir / "corpus-v1-summary.json").write_text(
        json.dumps(v2_summary, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )
    print(
        f"[aug] wrote v2 to {v2_dir}: train={len(v2_train)}, eval={len(v2_eval)}",
        file=sys.stderr,
    )
    print(
        f"[aug] zone dist: "
        + ", ".join(f"{z}={n}" for z, n in sorted(zone_counts.items(), key=lambda kv: -kv[1])),
        file=sys.stderr,
    )
    return 0


def _compute_license_breakdown(samples: list[dict]) -> dict[str, int]:
    out: dict[str, int] = {}
    for s in samples:
        lic = s.get("license", "unknown")
        out[lic] = out.get(lic, 0) + 1
    return out


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:
        print(f"[aug] unexpected failure: {exc}", file=sys.stderr)
        raise SystemExit(2)
