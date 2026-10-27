"""Frozen v1 corpus boundary. Pure stdlib; validate before model loading."""
from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ZONE_LABELS = (
    "journal", "decisions", "reflections", "cases", "patterns", "system",
    "collective", "proactive", "insights", "soul", "reserved_1", "reserved_2",
)
TRAINABLE_ZONES = ZONE_LABELS[:10]


class CorpusContractError(ValueError):
    """A corpus cannot safely feed the frozen v1 training path."""


def validate_zone_labels(labels: object) -> None:
    if labels != list(ZONE_LABELS):
        raise CorpusContractError("Corpus zone labels must exactly match frozen kartograf-v1 ordering")


def _json(path: Path):
    if path.is_symlink() or not path.is_file():
        raise CorpusContractError("Corpus metadata must be regular local files")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, UnicodeError):
        raise CorpusContractError("Missing or malformed corpus metadata") from None


def _rows(path: Path):
    if path.is_symlink() or not path.is_file():
        raise CorpusContractError("Corpus JSONL must be regular local files")
    try:
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                if line.strip():
                    row = json.loads(line)
                    if not isinstance(row, dict):
                        raise ValueError()
                    yield row
    except (OSError, ValueError, UnicodeError):
        raise CorpusContractError("Missing or malformed corpus JSONL") from None


def validate_corpus(root: Path, *, require_pairs: bool = False,
                    require_eval: bool = False) -> dict:
    """Rehash/re-scan actual data; summary flags alone are not evidence."""
    validate_zone_labels(_json(root / "zone-labels.json"))
    summary = _json(root / "corpus-v1-summary.json")
    if (not isinstance(summary, dict)
            or not isinstance(summary.get("secret_scan"), dict)
            or not isinstance(summary.get("vault_denylist"), dict)
            or summary["secret_scan"].get("clean") is not True
            or summary["vault_denylist"].get("enforced") is not True):
        raise CorpusContractError("Corpus does not declare clean output and enforced vault exclusions")
    audit = _json(root / "license-audit.json")
    if not isinstance(audit, dict):
        raise CorpusContractError("Malformed license provenance")
    pools = {}
    counts = {}
    for split in ("train", "eval"):
        pool = {}
        zones = Counter()
        for row in _rows(root / f"{split}.jsonl"):
            text = row.get("content")
            if not isinstance(text, str) or not text.strip():
                raise CorpusContractError("Corpus contains empty or non-text content")
            try:
                encoded = text.encode("utf-8")
            except UnicodeError:
                raise CorpusContractError("Corpus contains malformed Unicode") from None
            sha = hashlib.sha256(encoded).hexdigest()
            if row.get("sha256") != sha:
                raise CorpusContractError("Corpus content/hash mismatch")
            if scan_secrets(encoded) or scan_secrets(json.dumps(row, ensure_ascii=False).encode("utf-8")):
                raise CorpusContractError("Corpus content contains a secret-pattern match")
            if sha in pool:
                raise CorpusContractError("Duplicate content inside a corpus split")
            if row.get("zone") not in TRAINABLE_ZONES:
                raise CorpusContractError("Corpus sample uses an unsupported or reserved v1 zone")
            if not isinstance(row.get("source_path"), str) or not row["source_path"]:
                raise CorpusContractError("Corpus sample lacks source provenance")
            if row.get("license") not in (
                "repo:apache-2.0", "repo:cc-by-4.0", "operator:local-only", "operator:public",
            ):
                raise CorpusContractError("Corpus sample has an unrecognized license tag")
            attribution = audit.get(row["source_path"])
            if (not isinstance(attribution, dict) or attribution.get("sha256") != sha
                    or attribution.get("license") != row["license"]):
                raise CorpusContractError("Corpus row disagrees with license provenance")
            pool[sha] = row
            zones[row["zone"]] += 1
        pools[split] = pool
        counts[split] = dict(zones)
    if not pools["train"] or (require_eval and not pools["eval"]):
        raise CorpusContractError("Required corpus split is empty")
    if pools["train"].keys() & pools["eval"].keys():
        raise CorpusContractError("Train/eval content overlap")
    if summary.get("split") != {name: len(pool) for name, pool in pools.items()}:
        raise CorpusContractError("Corpus split counts disagree with actual data")
    if summary.get("source_count") != sum(len(pool) for pool in pools.values()):
        raise CorpusContractError("Corpus source count disagrees with actual data")
    pair_counts = {}
    if require_pairs:
        for split, filename in (("train", "pairs.jsonl"), ("eval", "eval-pairs.jsonl")):
            pool = pools[split]
            anchors = set()
            strides = set()
            for pair in _rows(root / filename):
                anchor, positive = pair.get("anchor_sha256"), pair.get("positive_sha256")
                negs = pair.get("hard_negatives_sha256")
                if (not isinstance(anchor, str) or not isinstance(positive, str)
                        or not isinstance(negs, list) or not negs
                        or not all(isinstance(value, str) for value in negs)):
                    raise CorpusContractError("Malformed contrastive pair")
                members = [anchor, positive, *negs]
                if any(value not in pool for value in members):
                    raise CorpusContractError("Pair references data outside its own split")
                if any(pool[value].get("ambiguous", False) for value in members):
                    raise CorpusContractError("Pair contains an ambiguous label")
                if len(set(members)) != len(members) or anchor in anchors:
                    raise CorpusContractError("Contrastive pair repeats a member or anchor")
                if any(pool[value]["zone"] == pool[anchor]["zone"] for value in negs):
                    raise CorpusContractError("Hard negative shares the anchor zone")
                anchors.add(anchor)
                strides.add(len(negs))
            if len(strides) > 1:
                raise CorpusContractError("Mixed hard-negative counts would break batching")
            if (split == "train" or require_eval) and not anchors:
                raise CorpusContractError("Required contrastive pair split is empty")
            pair_counts[split] = len(anchors)
    usable = {split: sum(not row.get("ambiguous", False) for row in pool.values())
              for split, pool in pools.items()}
    return {"valid": True, "schema": "kartograf-v1", "split": {k: len(v) for k, v in pools.items()},
            "per_zone": counts, "pair_counts": pair_counts, "unambiguous_samples": usable, "train_eval_overlap": 0}


SECRET_PATTERNS = [
    ("credential-assignment", re.compile(
        rb"(?:[a-z0-9_]*(?:token|secret|password|pepper|seed|private_key|api_key))[\"']?\s*[:=]\s*[\"'][^\"'\s]{8,}",
        re.IGNORECASE,
    )),
    ("aws-access-key", re.compile(rb"AKIA[0-9A-Z]{16}")),
    ("gcp-api-key", re.compile(rb"AIza[0-9A-Za-z\-_]{35}")),
    ("github-fine-grained-pat", re.compile(rb"github_pat_[A-Za-z0-9_]{30,}")),
    ("github-pat", re.compile(rb"ghp_[0-9A-Za-z]{36}")),
    ("anthropic-key", re.compile(rb"sk-ant-[A-Za-z0-9\-_]{20,}")),
    # Issue #274 (2026-04-30): OpenAI scopes the `sk-` prefix without
    # `ant-`; we need to catch proj/test/live/None forms or fresh OpenAI
    # keys land in the corpus and ship in embedding space.
    ("openai-key", re.compile(rb"sk-(admin|proj|test|live|None)-[A-Za-z0-9\-_]{20,}")),
    # Stripe secret + restricted keys (test + live), and webhook signing
    # secrets. All three appear in operator notes / runbooks if they
    # ever build a billing integration.
    ("stripe-secret-key", re.compile(rb"(sk|rk)_(test|live)_[A-Za-z0-9]{24,}")),
    ("stripe-webhook-secret", re.compile(rb"whsec_[A-Za-z0-9]{32,}")),
    ("slack-token", re.compile(rb"xox[baprs]-[0-9A-Za-z\-]{10,}")),
    ("jwt", re.compile(rb"eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+")),
    ("pem-private-key", re.compile(rb"-----BEGIN (RSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----")),
    # Require an opening quote to avoid false positives on `api_key: fn_call(...)`
    # matches scripts/secret-scan.sh:PATTERN exactly (post-v1.5.0 hotfix)
    ("api-key-assignment", re.compile(rb"api[_-]?key\s*[:=]\s*[\"'][A-Za-z0-9_\-]{16,}")),
    ("password-assignment", re.compile(rb"password\s*[:=]\s*[\"'][^\"']{8,}")),
    # Mistral keys are opaque 32-char base64 strings without a dedicated
    # prefix, so they ride `api-key-assignment` rather than getting a
    # standalone regex (a prefix-less pattern would false-positive on
    # UUIDs / hashes). Add a Mistral entry here if Mistral ships scoped
    # keys with a recognizable prefix.
]


def scan_secrets(data: bytes) -> list[str]:
    return [name for name, pattern in SECRET_PATTERNS if pattern.search(data)]
