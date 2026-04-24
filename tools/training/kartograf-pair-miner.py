#!/usr/bin/env python3
"""
Kartograf contrastive-pair miner — Y1 Q2 N32 Phase 1.

Retrofits an already-built corpus (kartograf-corpus.py output) with a
separate `pairs.jsonl` file encoding positive pairs and cross-zone hard
negatives for InfoNCE training. Additive — does not rewrite train.jsonl
or eval.jsonl. Bumps corpus-v1-summary.json with pair_count +
pair_mining_version without touching any pre-existing fields.

Three signals combine per KARTOGRAF-SPEC.md §Training corpus line 48:

  1. Git co-occurrence — for repo-path samples, paths that change in the
     same commits are topically related. Jaccard over commit-SHA sets.
  2. Temporal adjacency — for chain-block samples (no git history),
     consecutive blocks in the same chain tend to be related.
  3. Symbol similarity — TF-IDF over extracted identifiers, cosine sim.
     Used as tie-breaker for positives and as primary hard-negative signal
     (textually similar but labeled in a different zone).

Hard negatives: top-K cross-zone samples by symbol similarity. For
`system` anchors (the majority class at ~88% of labels), hard negs are
stratified across the remaining 9 live zones weighted by zone size so
we don't degenerate to one fallback zone.

Pure stdlib. No new heavyweight deps. Git log results cached to
`<corpus>/.git-log-cache.json` (auto-invalidates on mtime change of
HEAD ref).

USAGE:

  python3 tools/training/kartograf-pair-miner.py \\
      --corpus ~/.memphis/kartograf/corpus/v1 \\
      [--repo-root .] \\
      [--dry-run] \\
      [--top-k-positives 1] \\
      [--top-k-hard-negs 4]

OUTPUT (additive):

  <corpus>/pairs.jsonl               one line per anchor (see schema below)
  <corpus>/.git-log-cache.json       transparent cache; safe to delete
  <corpus>/corpus-v1-summary.json    bumped with pair_count + version

Exit codes:

  0 — success, pairs.jsonl written (or dry-run clean)
  1 — invalid corpus (missing train.jsonl / summary / zone-labels)
  2 — git or IO failure
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

PAIR_MINING_VERSION = "v1.1"

# Per-sample schema emitted to pairs.jsonl. Keeping this explicit so
# downstream loaders (kartograf_train.data) can schema-check.
#   {
#     "anchor_sha256":    hex64 — MUST exist in train.jsonl
#     "positive_sha256":  hex64 — MUST exist in train.jsonl (never self)
#     "positive_score":   float in [0, 1] — combined signal
#     "positive_strategy": "git-cooccur" | "temporal" | "symbol"
#     "hard_negatives_sha256": [hex64, ...] — K samples, all different zones
#     "hard_neg_scores": [float, ...] — same order, symbol-sim scores
#   }

# Stopwords for symbol extraction. Mostly language keywords +
# single-letter / very common tokens that dominate TF without carrying
# topical signal.
STOPWORDS = frozenset({
    # Generic
    "this", "that", "with", "from", "into", "self", "none", "null",
    "true", "false", "return", "const", "type", "export", "import",
    "async", "await", "function", "class", "interface", "enum",
    "namespace", "module", "public", "private", "protected", "static",
    "readonly", "default", "yield", "throw", "catch", "finally", "try",
    "else", "then", "while", "break", "continue", "switch", "case",
    "typeof", "instanceof", "new", "delete", "void",
    # TypeScript / JavaScript
    "string", "number", "boolean", "object", "undefined", "unknown",
    "never", "record", "promise", "array", "readonly",
    # Rust
    "impl", "trait", "struct", "enum", "mod", "pub", "crate", "where",
    "match", "move", "ref", "fn", "let", "mut", "dyn", "box",
    # Python
    "def", "lambda", "raise", "except", "assert", "print", "import",
    # Numeric literals caught by regex (we still filter len<3 but some
    # pure digit tokens slip through via hex).
})

# Re-used from kartograf-corpus.py assumption: identifiers are the
# unit of meaning. Match camelCase / snake_case / PascalCase.
SYMBOL_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")


@dataclass
class Sample:
    """One line from train.jsonl, hydrated + enriched with symbols."""
    sha256: str
    source_path: str
    zone: str
    content: str
    license: str
    mutability: float
    ambiguous: bool
    is_chain: bool
    # Derived later.
    symbols: set[str] = field(default_factory=set)
    # Chain samples only: integer block index from filename.
    chain_block_idx: int | None = None
    chain_name: str | None = None


# ---------------------------------------------------------------------
# Corpus I/O
# ---------------------------------------------------------------------

def load_corpus(corpus_dir: Path) -> tuple[list[Sample], dict]:
    summary_path = corpus_dir / "corpus-v1-summary.json"
    train_path = corpus_dir / "train.jsonl"
    zone_labels_path = corpus_dir / "zone-labels.json"
    for p in (summary_path, train_path, zone_labels_path):
        if not p.exists():
            raise SystemExit(
                f"[pair-miner] required corpus file missing: {p}. "
                f"Run tools/training/kartograf-corpus.py first."
            )
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    if not summary.get("secret_scan", {}).get("clean", False):
        raise SystemExit(
            "[pair-miner] corpus secret_scan.clean=false — refusing to mine pairs."
        )
    if not summary.get("vault_denylist", {}).get("enforced", False):
        raise SystemExit(
            "[pair-miner] corpus vault_denylist.enforced=false — refusing to mine pairs."
        )
    samples: list[Sample] = []
    sha_first_idx: dict[str, int] = {}
    dup_count = 0
    with train_path.open(encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, start=1):
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            sha = obj["sha256"]
            # Kartograf corpus legitimately contains content-duplicates
            # (e.g., cyclic system-chain messages produce 100+ identical
            # blocks across different source_paths). Dedupe by content
            # hash and keep the earliest occurrence — training sees
            # each unique content exactly once; source_path multiplicity
            # is preserved only in license-audit.json and is not a
            # contrastive signal.
            if sha in sha_first_idx:
                dup_count += 1
                continue
            sha_first_idx[sha] = len(samples)
            src = obj["source_path"]
            is_chain = src.startswith("chain:")
            chain_name, block_idx = None, None
            if is_chain:
                # Format is `chain:<name>/<block>.json` per corpus builder.
                try:
                    _, rest = src.split(":", 1)
                    chain_name, fname = rest.split("/", 1)
                    block_idx = int(fname.split(".", 1)[0])
                except (ValueError, IndexError):
                    # Defensive: should never happen given corpus invariants.
                    is_chain = False
            samples.append(Sample(
                sha256=sha,
                source_path=src,
                zone=obj["zone"],
                content=obj["content"],
                license=obj["license"],
                mutability=float(obj.get("mutability", 0.0)),
                ambiguous=bool(obj.get("ambiguous", False)),
                is_chain=is_chain,
                chain_name=chain_name,
                chain_block_idx=block_idx,
            ))
    if dup_count > 0:
        print(
            f"[pair-miner] deduped {dup_count} content-duplicate samples "
            f"(total unique: {len(samples)})",
            file=sys.stderr,
        )
    return samples, summary


# ---------------------------------------------------------------------
# Symbol extraction + TF-IDF
# ---------------------------------------------------------------------

def extract_symbols(text: str) -> set[str]:
    """Lowercased identifier set minus stopwords + very-short tokens."""
    out: set[str] = set()
    for m in SYMBOL_RE.finditer(text):
        tok = m.group(0).lower()
        if len(tok) < 4:
            continue
        if tok in STOPWORDS:
            continue
        # Drop purely numeric or very short hex-ish garbage.
        if tok.replace("_", "").isdigit():
            continue
        out.add(tok)
    return out


def build_tfidf(samples: list[Sample]) -> dict[str, dict[str, float]]:
    """Return {sha256 -> {symbol -> tfidf weight}}. Sparse dicts."""
    n_docs = len(samples)
    df: Counter[str] = Counter()
    for s in samples:
        for sym in s.symbols:
            df[sym] += 1
    # Guard against pathologically frequent symbols (in every doc) that
    # carry zero discriminative value — idf would be 0 but keep them
    # anyway; cosine handles it.
    idf: dict[str, float] = {}
    for sym, dfreq in df.items():
        # Smooth idf: log((N + 1) / (df + 1)) + 1. Avoids div-by-zero
        # and keeps weights positive for single-doc symbols.
        idf[sym] = math.log((n_docs + 1) / (dfreq + 1)) + 1.0
    vectors: dict[str, dict[str, float]] = {}
    for s in samples:
        # TF = 1.0 per symbol since we dedupe in extract_symbols. Weight
        # = idf directly; L2-normalize for stable cosine.
        vec: dict[str, float] = {}
        for sym in s.symbols:
            vec[sym] = idf[sym]
        norm = math.sqrt(sum(w * w for w in vec.values()))
        if norm > 0:
            for k in vec:
                vec[k] /= norm
        vectors[s.sha256] = vec
    return vectors


def cosine_sparse(v1: dict[str, float], v2: dict[str, float]) -> float:
    """Dot product of two L2-normalized sparse vectors. Both vectors are
    already unit-norm, so dot == cosine."""
    if not v1 or not v2:
        return 0.0
    # Iterate the smaller vector for efficiency.
    if len(v2) < len(v1):
        v1, v2 = v2, v1
    s = 0.0
    for k, w in v1.items():
        w2 = v2.get(k)
        if w2 is not None:
            s += w * w2
    return s


# ---------------------------------------------------------------------
# Git co-occurrence (repo paths only)
# ---------------------------------------------------------------------

def _git_head_sha(repo_root: Path) -> str:
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=True,
            timeout=15,
        )
        return out.stdout.strip()
    except (subprocess.SubprocessError, FileNotFoundError) as exc:
        raise SystemExit(f"[pair-miner] git rev-parse failed: {exc}")


def collect_git_history(
    repo_root: Path,
    paths: list[str],
    cache_path: Path,
) -> dict[str, list[str]]:
    """Return {source_path -> list_of_commit_shas}. Cached to disk;
    cache keyed by HEAD sha. Paths not tracked in git return []."""
    head = _git_head_sha(repo_root)
    cache: dict[str, object] = {}
    if cache_path.exists():
        try:
            cache = json.loads(cache_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            cache = {}
    if cache.get("head") != head:
        # Cache invalidated; start fresh.
        cache = {"head": head, "paths": {}}
    cached_paths: dict[str, list[str]] = cache.get("paths", {})  # type: ignore[assignment]
    misses = [p for p in paths if p not in cached_paths]
    if misses:
        print(
            f"[pair-miner] git log for {len(misses)} uncached paths "
            f"(of {len(paths)} total)",
            file=sys.stderr,
        )
    for i, path in enumerate(misses):
        if i > 0 and i % 50 == 0:
            print(f"[pair-miner]   ... {i}/{len(misses)}", file=sys.stderr)
        try:
            out = subprocess.run(
                ["git", "log", "--follow", "--format=%H", "--", path],
                cwd=repo_root,
                capture_output=True,
                text=True,
                check=False,
                timeout=30,
            )
            if out.returncode != 0:
                # Non-zero can mean untracked file; treat as empty history.
                cached_paths[path] = []
                continue
            cached_paths[path] = [
                ln.strip() for ln in out.stdout.splitlines() if ln.strip()
            ]
        except subprocess.TimeoutExpired:
            print(f"[pair-miner]   timeout on {path}; marking empty", file=sys.stderr)
            cached_paths[path] = []
    cache["paths"] = cached_paths
    cache_path.write_text(
        json.dumps(cache, separators=(",", ":")),
        encoding="utf-8",
    )
    return {p: cached_paths.get(p, []) for p in paths}


def jaccard(a: set[str], b: set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    if inter == 0:
        return 0.0
    union = len(a | b)
    return inter / union


# ---------------------------------------------------------------------
# Pair assembly
# ---------------------------------------------------------------------

def find_temporal_positive(
    anchor: Sample,
    chain_index: dict[tuple[str, int], Sample],
) -> tuple[Sample, float] | None:
    """For a chain-block anchor, return the nearest neighboring block
    in the same chain. Consecutive == 1.0 score; distance 2 == 0.5."""
    if not anchor.is_chain or anchor.chain_name is None:
        return None
    for distance in (1, 2):
        for direction in (+1, -1):
            key = (anchor.chain_name, anchor.chain_block_idx + direction * distance)
            cand = chain_index.get(key)
            if cand is not None:
                return cand, 1.0 if distance == 1 else 0.5
    return None


def find_git_cooccur_positive(
    anchor: Sample,
    commit_index: dict[str, set[str]],
    path_to_commits: dict[str, set[str]],
    sha_by_path: dict[str, str],
) -> tuple[str, float] | None:
    """For a repo-path anchor, find the path with highest Jaccard over
    commit sets. Returns (positive_sha256, score) or None if no
    meaningful co-occurrence (>=2 shared commits and jaccard > 0.1)."""
    anchor_commits = path_to_commits.get(anchor.source_path, set())
    if len(anchor_commits) < 2:
        # Paths with 0 or 1 commits: co-occurrence is noise.
        return None
    candidates: Counter[str] = Counter()
    for commit in anchor_commits:
        for other_path in commit_index.get(commit, set()):
            if other_path == anchor.source_path:
                continue
            candidates[other_path] += 1
    best_path = None
    best_score = 0.0
    for other_path, shared in candidates.most_common(20):
        if shared < 2:
            break
        other_commits = path_to_commits.get(other_path, set())
        score = jaccard(anchor_commits, other_commits)
        if score > best_score:
            best_score = score
            best_path = other_path
    if best_path is None or best_score < 0.1:
        return None
    pos_sha = sha_by_path.get(best_path)
    if pos_sha is None:
        # Co-occur partner isn't in the corpus (filtered by allowlist or
        # zone-empty). Skip.
        return None
    return pos_sha, best_score


def find_hard_negatives(
    anchor: Sample,
    all_samples: list[Sample],
    tfidf: dict[str, dict[str, float]],
    zone_buckets: dict[str, list[int]],
    k: int,
    exclude_sha: set[str] | None = None,
) -> list[tuple[str, float]]:
    """Return K (sha256, score) from DIFFERENT zones than anchor,
    ranked by symbol cosine similarity (highest first).

    For `system` anchors (majority class), the pool naturally excludes
    `system` samples and we pick from the remaining zones. We stratify
    by zone so we don't get 4 hard negs all from `reflections`.

    exclude_sha: shas that MUST NOT appear in hard negs (the positive
    can be in a different zone than the anchor when picked via
    git-cooccur, so callers pass {positive_sha} to keep it out of the
    negative set).
    """
    anchor_vec = tfidf[anchor.sha256]
    exclude = exclude_sha or set()
    # Group candidate indices by zone, excluding anchor's own zone.
    candidates_by_zone: dict[str, list[tuple[int, float]]] = defaultdict(list)
    for zone, idxs in zone_buckets.items():
        if zone == anchor.zone:
            continue
        for idx in idxs:
            cand = all_samples[idx]
            if cand.sha256 in exclude:
                continue
            sim = cosine_sparse(anchor_vec, tfidf[cand.sha256])
            if sim <= 0.0:
                continue
            candidates_by_zone[zone].append((idx, sim))
    # Sort per zone descending.
    for zone in candidates_by_zone:
        candidates_by_zone[zone].sort(key=lambda t: -t[1])
    # Round-robin through zones to hit diversity target.
    picked: list[tuple[str, float]] = []
    zones_ordered = sorted(
        candidates_by_zone.keys(),
        key=lambda z: -len(candidates_by_zone[z]),
    )
    cursor = {z: 0 for z in zones_ordered}
    while len(picked) < k and zones_ordered:
        for zone in list(zones_ordered):
            if len(picked) >= k:
                break
            pos = cursor[zone]
            if pos >= len(candidates_by_zone[zone]):
                zones_ordered.remove(zone)
                continue
            idx, sim = candidates_by_zone[zone][pos]
            picked.append((all_samples[idx].sha256, sim))
            cursor[zone] = pos + 1
    return picked


# ---------------------------------------------------------------------
# Main driver
# ---------------------------------------------------------------------

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--corpus", required=True, type=Path,
                        help="Corpus directory (contains train.jsonl + summary).")
    parser.add_argument("--repo-root", type=Path, default=Path.cwd(),
                        help="Git repo root for co-occurrence mining (default: cwd).")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report stats without writing pairs.jsonl.")
    parser.add_argument("--top-k-hard-negs", type=int, default=4,
                        help="Hard negatives per anchor (default 4).")
    parser.add_argument("--symbol-tiebreak-weight", type=float, default=0.4,
                        help="Weight of symbol sim in combined positive score (default 0.4).")
    args = parser.parse_args()

    corpus_dir = args.corpus.expanduser().resolve()
    repo_root = args.repo_root.expanduser().resolve()

    print(f"[pair-miner] corpus={corpus_dir}", file=sys.stderr)
    print(f"[pair-miner] repo_root={repo_root}", file=sys.stderr)

    t0 = time.time()

    # 1) Load
    samples, summary = load_corpus(corpus_dir)
    print(f"[pair-miner] loaded {len(samples)} samples", file=sys.stderr)

    # 2) Symbols + TF-IDF
    for s in samples:
        s.symbols = extract_symbols(s.content)
    # Filter out anchors with tiny symbol sets — they can't contribute
    # meaningful contrastive signal. Report separately.
    sparse_samples = [s for s in samples if len(s.symbols) < 3]
    print(
        f"[pair-miner] {len(sparse_samples)} samples with <3 symbols "
        f"(will still be anchor-emittable if temporal/git signals exist)",
        file=sys.stderr,
    )
    tfidf = build_tfidf(samples)
    print(f"[pair-miner] TF-IDF built ({time.time() - t0:.1f}s)", file=sys.stderr)

    # 3) Build indices
    sha_by_path: dict[str, str] = {}
    for s in samples:
        # Repo paths are unique; chain paths are also unique (one block
        # per file). Last-write-wins is fine since there should be no
        # collisions by construction.
        sha_by_path[s.source_path] = s.sha256
    chain_index: dict[tuple[str, int], Sample] = {}
    zone_buckets: dict[str, list[int]] = defaultdict(list)
    for i, s in enumerate(samples):
        zone_buckets[s.zone].append(i)
        if s.is_chain and s.chain_name and s.chain_block_idx is not None:
            chain_index[(s.chain_name, s.chain_block_idx)] = s

    # 4) Git co-occurrence (repo paths only)
    repo_paths = [s.source_path for s in samples if not s.is_chain
                  and not s.source_path.startswith("config:")]
    # Dedup while preserving order.
    seen: set[str] = set()
    repo_paths_unique = []
    for p in repo_paths:
        if p not in seen:
            seen.add(p)
            repo_paths_unique.append(p)
    cache_path = corpus_dir / ".git-log-cache.json"
    path_commits = collect_git_history(repo_root, repo_paths_unique, cache_path)
    # Build inverse index commit -> {paths}
    commit_index: dict[str, set[str]] = defaultdict(set)
    path_commits_as_sets: dict[str, set[str]] = {}
    for path, commits in path_commits.items():
        cs = set(commits)
        path_commits_as_sets[path] = cs
        for c in cs:
            commit_index[c].add(path)
    # Sanity: how many repo paths have usable history?
    usable_git = sum(1 for cs in path_commits_as_sets.values() if len(cs) >= 2)
    print(
        f"[pair-miner] git history: {usable_git}/{len(repo_paths_unique)} "
        f"paths have >=2 commits ({time.time() - t0:.1f}s)",
        file=sys.stderr,
    )

    # 5) Pair assembly
    pairs_out: list[dict] = []
    stats = Counter()
    t_pairs = time.time()
    for i, anchor in enumerate(samples):
        if i > 0 and i % 200 == 0:
            print(
                f"[pair-miner]   paired {i}/{len(samples)} "
                f"({time.time() - t_pairs:.1f}s)",
                file=sys.stderr,
            )
        positive_sha: str | None = None
        positive_score: float = 0.0
        positive_strategy: str | None = None

        # Primary signal — git for repo, temporal for chain.
        if anchor.is_chain:
            tp = find_temporal_positive(anchor, chain_index)
            if tp is not None:
                cand, primary_score = tp
                # Tiebreak with symbol sim to pick the *best* neighbor
                # when both ±1 and ±2 are available.
                sym_sim = cosine_sparse(tfidf[anchor.sha256], tfidf[cand.sha256])
                combined = (1 - args.symbol_tiebreak_weight) * primary_score + \
                           args.symbol_tiebreak_weight * sym_sim
                positive_sha = cand.sha256
                positive_score = combined
                positive_strategy = "temporal"
        else:
            gc = find_git_cooccur_positive(
                anchor, commit_index, path_commits_as_sets, sha_by_path,
            )
            if gc is not None:
                pos_sha, git_score = gc
                sym_sim = cosine_sparse(tfidf[anchor.sha256], tfidf[pos_sha])
                combined = (1 - args.symbol_tiebreak_weight) * git_score + \
                           args.symbol_tiebreak_weight * sym_sim
                positive_sha = pos_sha
                positive_score = combined
                positive_strategy = "git-cooccur"

        # Fallback: pure symbol similarity, same-zone preferred.
        if positive_sha is None:
            anchor_vec = tfidf[anchor.sha256]
            best_idx, best_sim = -1, 0.0
            # Prefer same-zone candidates for the symbol fallback (they
            # should be topically closer, not just lexically similar).
            candidate_idxs = [j for j in zone_buckets.get(anchor.zone, [])
                              if samples[j].sha256 != anchor.sha256]
            if not candidate_idxs:
                # Zone-of-one — fall back to all other samples.
                candidate_idxs = [j for j in range(len(samples))
                                  if samples[j].sha256 != anchor.sha256]
            for j in candidate_idxs:
                sim = cosine_sparse(anchor_vec, tfidf[samples[j].sha256])
                if sim > best_sim:
                    best_sim = sim
                    best_idx = j
            if best_idx >= 0 and best_sim > 0.05:
                positive_sha = samples[best_idx].sha256
                positive_score = best_sim
                positive_strategy = "symbol"

        if positive_sha is None:
            # Can't emit a pair for this anchor — sample has neither
            # git history, chain neighbor, nor any symbol overlap with
            # another doc. Skip; trainer will fall back to in-batch
            # augmentation positives for these during training.
            stats["skipped_no_positive"] += 1
            continue

        # Hard negatives — positive can legitimately be in a different
        # zone than anchor (git-cooccur crosses zone boundaries), so
        # explicitly exclude it from the hard-neg candidate pool.
        hard_negs = find_hard_negatives(
            anchor, samples, tfidf, zone_buckets, args.top_k_hard_negs,
            exclude_sha={positive_sha},
        )
        if not hard_negs:
            # Only one zone populated — impossible in practice since we
            # have at least 7 zones with samples — but safe-guard.
            stats["skipped_no_hard_negs"] += 1
            continue

        pairs_out.append({
            "anchor_sha256": anchor.sha256,
            "positive_sha256": positive_sha,
            "positive_score": round(positive_score, 6),
            "positive_strategy": positive_strategy,
            "hard_negatives_sha256": [h[0] for h in hard_negs],
            "hard_neg_scores": [round(h[1], 6) for h in hard_negs],
        })
        stats[f"emitted_{positive_strategy}"] += 1

    print(
        f"[pair-miner] {len(pairs_out)} pairs emitted "
        f"({time.time() - t_pairs:.1f}s). Breakdown: {dict(stats)}",
        file=sys.stderr,
    )

    # 6) Output
    if args.dry_run:
        print("[pair-miner] --dry-run: no files written", file=sys.stderr)
        return 0

    pairs_path = corpus_dir / "pairs.jsonl"
    with pairs_path.open("w", encoding="utf-8") as fh:
        for rec in pairs_out:
            fh.write(json.dumps(rec, separators=(",", ":")) + "\n")
    print(f"[pair-miner] wrote {pairs_path} ({len(pairs_out)} pairs)", file=sys.stderr)

    # 7) Summary bump — preserve existing fields, add ours.
    summary_path = corpus_dir / "corpus-v1-summary.json"
    summary["pair_mining"] = {
        "version": PAIR_MINING_VERSION,
        "pair_count": len(pairs_out),
        "top_k_hard_negs": args.top_k_hard_negs,
        "strategy_breakdown": {
            k.removeprefix("emitted_"): v
            for k, v in stats.items()
            if k.startswith("emitted_")
        },
        "skipped": {
            k: v for k, v in stats.items() if k.startswith("skipped_")
        },
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    summary_path.write_text(
        json.dumps(summary, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )
    print(f"[pair-miner] updated {summary_path}", file=sys.stderr)
    print(f"[pair-miner] done in {time.time() - t0:.1f}s", file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:  # pragma: no cover — final safety net
        print(f"[pair-miner] unexpected failure: {exc}", file=sys.stderr)
        raise SystemExit(2)
