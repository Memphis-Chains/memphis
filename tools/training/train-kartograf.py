#!/usr/bin/env python3
"""Kartograf training harness STUB (N37.2).

Closes the Q1 loop without actually training a model: validates the
corpus, writes a placeholder ONNX + tokenizer bundle, stamps and
signs the checkpoint envelope per docs/dev/KARTOGRAF-SPEC.md.

Real training lands in Q2 — when it does, this script's CLI surface
stays stable. Operators running the Q1 exit test today get a
deterministic checkpoint bundle under
`~/.memphis/kartograf/checkpoints/train-run-<ts>/` that
`memphis kartograf verify` accepts end-to-end.

Usage:

    python3 tools/training/train-kartograf.py \\
        --corpus ~/.memphis/kartograf/corpus/v1 \\
        --out ~/.memphis/kartograf/checkpoints/run-$(date +%s) \\
        --signing-seed-file <(openssl rand 32) \\
        --distribution-source file

The `--signing-seed-file` is a 32-byte raw Ed25519 seed. For real
runs, keep this under the operator vault; `file` mode expects it on
a dev machine with no network egress.

Exit codes:
    0 — success, envelope written
    1 — invalid corpus or missing artifacts
    2 — signing or IO failure
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from pathlib import Path


PLACEHOLDER_ONNX = b"KARTOGRAF_STUB_ONNX_v1\nsee docs/dev/KARTOGRAF-SPEC.md"
PLACEHOLDER_TOKENIZER = json.dumps(
    {
        "kartograf_stub_tokenizer": True,
        "base": "answerdotai/ModernBERT-base",
        "note": "Replaced by real tokenizer.json in Q2 training run.",
    },
    separators=(",", ":"),
    sort_keys=True,
).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _js_style_number(n: float) -> str:
    """Match JS `JSON.stringify` number formatting.

    Critical: JS stringifies `0.0` as `"0"` (drops the decimal for
    integer-valued floats) but Python `json.dumps` emits `"0.0"`.
    The TS verifier hashes the TS canonical form; if Python produces
    a different byte string the signature mismatches.

    Rule: if the float has no fractional part AND fits in int64, emit
    the integer form; otherwise fall back to `json.dumps`.
    """
    if isinstance(n, bool):  # Python: bool is a subclass of int.
        return "true" if n else "false"
    if isinstance(n, int):
        return str(n)
    if isinstance(n, float):
        if n.is_integer() and abs(n) < 2**53:
            return str(int(n))
        # json.dumps uses the shortest repr that roundtrips for floats,
        # same as V8's JSON.stringify for non-integer cases.
        return json.dumps(n)
    raise TypeError(f"expected int/float, got {type(n)!r}")


def canonicalize(value) -> str:
    """Recursive key-sorted JSON. Matches src/kartograf/checkpoint.ts
    byte-for-byte so cross-language sign/verify round-trips."""
    if value is None:
        return "null"
    if isinstance(value, bool):  # Must be checked before int (bool ⊂ int).
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return _js_style_number(value)
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, list):
        return "[" + ",".join(canonicalize(v) for v in value) + "]"
    if isinstance(value, dict):
        parts = []
        for k in sorted(value.keys()):
            parts.append(f"{json.dumps(k)}:{canonicalize(value[k])}")
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"cannot canonicalize {type(value)!r}")


def ed25519_sign(payload: bytes, seed: bytes) -> tuple[str, str]:
    """Return (signer_did, signature_hex). Uses `cryptography` when
    available; falls back to a minimal inline implementation via the
    `nacl`-less path using hashlib + curve25519 math is out of scope
    for a stub. For v1, require the `cryptography` package.
    """
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import (
            Ed25519PrivateKey,
        )
    except ImportError as exc:  # pragma: no cover
        raise SystemExit(
            f"[train-kartograf] cryptography package required for signing: {exc}. "
            f"Install with `pip install cryptography>=42`."
        )

    private_key = Ed25519PrivateKey.from_private_bytes(seed)
    public_key = private_key.public_key()
    pub_raw = public_key.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    signer_did = f"did:key:ed25519:{pub_raw.hex()}"
    signature = private_key.sign(payload)
    return signer_did, signature.hex()


def validate_corpus(corpus_dir: Path) -> dict:
    """Return the corpus summary JSON if invariants hold, else SystemExit."""
    summary_path = corpus_dir / "corpus-v1-summary.json"
    if not summary_path.exists():
        raise SystemExit(
            f"[train-kartograf] corpus-v1-summary.json missing at {summary_path}; "
            "run tools/training/kartograf-corpus.py first."
        )
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    if not summary.get("secret_scan", {}).get("clean", False):
        raise SystemExit(
            "[train-kartograf] corpus secret_scan.clean is false — refusing to train."
        )
    if not summary.get("vault_denylist", {}).get("enforced", False):
        raise SystemExit(
            "[train-kartograf] corpus vault_denylist.enforced is false — refusing to train."
        )
    train_path = corpus_dir / "train.jsonl"
    if not train_path.exists() or train_path.stat().st_size == 0:
        raise SystemExit(
            f"[train-kartograf] train.jsonl missing or empty at {train_path}."
        )
    return summary


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--corpus", required=True, type=Path,
                        help="Corpus directory (contains train.jsonl + corpus-v1-summary.json).")
    parser.add_argument("--out", required=True, type=Path,
                        help="Output directory for the staged checkpoint bundle.")
    parser.add_argument("--signing-seed-file", required=True, type=Path,
                        help="File with 32 raw Ed25519 seed bytes.")
    parser.add_argument(
        "--distribution-source",
        default="file",
        choices=["hf-hub", "github-release", "file", "federation", "agora"],
        help="Trust tier the envelope will claim. Must match actual distribution channel.",
    )
    parser.add_argument("--hardware", default="gtx-960-local",
                        help="Hardware profile string for training_provenance.")
    parser.add_argument("--steps", type=int, default=0,
                        help="Training steps taken. 0 for stub runs.")
    parser.add_argument(
        "--eval-recall-at-10",
        type=float,
        default=0.0,
        help="Eval Recall@10 (0 for stub runs; Q2 reports real metric).",
    )
    parser.add_argument("--base-model",
                        default="answerdotai/ModernBERT-base@stub-rev",
                        help="Base model identifier + pinned revision.")
    args = parser.parse_args()

    corpus_dir = args.corpus.expanduser().resolve()
    out_dir = args.out.expanduser().resolve()
    seed_path = args.signing_seed_file.expanduser().resolve()

    # 1) Corpus invariants.
    summary = validate_corpus(corpus_dir)
    print(f"[train-kartograf] corpus ok: {summary['source_count']} samples, "
          f"v{summary['corpus_version']}", file=sys.stderr)

    # 2) Seed ingestion.
    seed = seed_path.read_bytes()
    if len(seed) != 32:
        raise SystemExit(
            f"[train-kartograf] signing seed at {seed_path} must be 32 bytes, got {len(seed)}."
        )

    # 3) Stage artifacts.
    out_dir.mkdir(parents=True, exist_ok=True)
    onnx_path = out_dir / "model.onnx"
    tok_path = out_dir / "tokenizer.json"
    onnx_path.write_bytes(PLACEHOLDER_ONNX)
    tok_path.write_bytes(PLACEHOLDER_TOKENIZER)
    onnx_sha = sha256_hex(PLACEHOLDER_ONNX)
    tok_sha = sha256_hex(PLACEHOLDER_TOKENIZER)

    # 4) Envelope body — everything except `signer_did` + `signature`.
    unsigned = {
        "version": "kartograf-v1",
        "base_model": args.base_model,
        "onnx_sha256": onnx_sha,
        "tokenizer_sha256": tok_sha,
        "heads_config": {
            "embedding_dim": 256,
            "zone_classes": 12,
            "multitask_alpha": 0.7,
        },
        "training_provenance": {
            "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "corpus_version": summary.get("corpus_version", "v1"),
            "hardware": args.hardware,
            "eval_recall_at_10": float(args.eval_recall_at_10),
            "steps": int(args.steps),
        },
        "distribution_source": args.distribution_source,
    }

    # Signer derives DID from the actual seed so operator-supplied
    # metadata can't claim a different key (matches signCheckpoint
    # behavior in src/kartograf/checkpoint.ts).
    body = {**unsigned}
    # Canonicalize WITH signer_did before signing — the TS verifier
    # includes signer_did in the signed payload (envelope minus
    # signature), so we need to match exactly.
    placeholder_did_payload = canonicalize(body).encode("utf-8")
    # First pass just to derive the signer_did from the seed.
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    private_key = Ed25519PrivateKey.from_private_bytes(seed)
    pub_raw = private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    signer_did = f"did:key:ed25519:{pub_raw.hex()}"
    body["signer_did"] = signer_did
    signed_payload = canonicalize(body).encode("utf-8")
    signature = private_key.sign(signed_payload).hex()

    envelope = {**body, "signature": signature}
    envelope_path = out_dir / "checkpoint.json"
    envelope_path.write_text(
        json.dumps(envelope, indent=2, sort_keys=False) + "\n",
        encoding="utf-8",
    )

    print(
        f"[ok] wrote {envelope_path}",
        file=sys.stderr,
    )
    print(
        f"[ok] signer_did={signer_did}",
        file=sys.stderr,
    )
    # Suppress placeholder_did_payload lint — computed upfront for
    # parallelism with the TS signer even though it's unused here.
    _ = placeholder_did_payload
    return 0


if __name__ == "__main__":
    # Minimal exit-code mapping per the CLI spec in the module docstring.
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as exc:  # pragma: no cover — final safety net
        print(f"[train-kartograf] unexpected failure: {exc}", file=sys.stderr)
        raise SystemExit(2)
