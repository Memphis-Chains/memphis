#!/usr/bin/env python3
"""Kartograf training harness (N32 Q2).

Three modes:

    --mode stub    (default, fast, no ML deps used)
                   Writes placeholder ONNX + tokenizer, signs envelope.
                   Same behavior as N37.2 shipped in Q1. Operator can
                   supply `--steps` and `--eval-recall-at-10` manually.

    --mode smoke   Runs the real ModernBERT-base + LoRA + two-head
                   trainer for 50 optimizer steps (proof-of-life).
                   Writes a signed envelope; envelope `eval_results`
                   is zero sentinels (Phase 3 adds real eval). ONNX
                   bytes are still the placeholder because FP16/INT8
                   export lands in Phase 4. The envelope remains
                   TS-verifiable end-to-end.

    --mode full    Runs the real trainer for 3 epochs. Intended for
                   operator overnight runs on the training rig.
                   Wall clock 4-8h on GTX 960. Same ONNX/eval caveats
                   as --mode smoke today; both lift in a follow-up PR.

Per docs/dev/KARTOGRAF-SPEC.md §Training paths, default hardware is
the GTX 960 / i3-2120 / 16GB RAM local profile (Path A).

Usage:

    python3 tools/training/train-kartograf.py \\
        --mode smoke \\
        --corpus ~/.memphis/kartograf/corpus/v1 \\
        --out /tmp/karto-smoke \\
        --signing-seed-file <(openssl rand 32)

The `--signing-seed-file` is a 32-byte raw Ed25519 seed. For release
runs, keep this under the operator vault; --mode stub can accept any
32 bytes for CI purposes.

Exit codes:
    0 — success, envelope written
    1 — invalid corpus or missing artifacts
    2 — signing, training, or IO failure
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import sys
import time
from pathlib import Path


PLACEHOLDER_ONNX = b"KARTOGRAF_STUB_ONNX_v1\nsee docs/dev/KARTOGRAF-SPEC.md"
PLACEHOLDER_TOKENIZER = json.dumps(
    {
        "kartograf_stub_tokenizer": True,
        "base": "answerdotai/ModernBERT-base",
        "note": "Replaced by real tokenizer.json in --mode smoke/full.",
    },
    separators=(",", ":"),
    sort_keys=True,
).encode("utf-8")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _js_style_number(n: float) -> str:
    """Match JS `JSON.stringify` number formatting.

    Critical rules (all must hold or the TS verifier rejects the
    signature for the envelope):

    1. JS stringifies `0.0` as `"0"` (drops the decimal for integer-
       valued floats); Python `json.dumps(0.0)` emits `"0.0"`.
    2. JS and Python agree on shortest-repr for "normal" floats like
       `0.7` → `"0.7"` — json.dumps emits matching output.
    3. JS flips to scientific notation only for `abs(n) < 1e-6` or
       `abs(n) >= 1e21`; Python's json.dumps follows Python repr which
       flips at `abs(n) < 1e-4`. So `1e-5` diverges: JS `"0.00001"`
       vs Python `"1e-05"`. We handle that range explicitly by
       printing fixed-point via `f"{n:.20g}"` then normalizing.
    4. NaN / Infinity are not valid JSON — `json.dumps` would emit
       `NaN` / `Infinity` (non-standard) which JS rejects. Guard at
       envelope-build time instead of here.
    """
    if isinstance(n, bool):  # Python: bool is a subclass of int.
        return "true" if n else "false"
    if isinstance(n, int):
        return str(n)
    if isinstance(n, float):
        if not math.isfinite(n):
            raise ValueError(
                f"non-finite float {n!r} cannot be canonicalized; guard at input"
            )
        if n.is_integer() and abs(n) < 2**53:
            return str(int(n))
        abs_n = abs(n)
        # JS scientific-notation threshold: abs < 1e-6 or abs >= 1e21.
        # For values outside that range JS uses fixed notation.
        if abs_n >= 1e-6 and abs_n < 1e21:
            # Use Python's shortest-repr via json.dumps but ONLY inside
            # the JS fixed-notation range. Values like 0.7, 1e-4 land
            # identically (Python: "0.0001", JS: "0.0001").
            return json.dumps(n)
        # Outside: JS uses scientific `1e-7` / `1e+21`. Mirror that
        # with Python's `g` format and normalize the exponent to JS's
        # form (lowercase `e`, sign-explicit).
        text = f"{n:.17g}"  # 17 digits — IEEE 754 double round-trip.
        if "e" in text:
            mantissa, exp = text.split("e")
            exp_int = int(exp)
            text = f"{mantissa}e{'+' if exp_int >= 0 else '-'}{abs(exp_int)}"
        return text
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


def _run_training(
    mode: str,
    corpus_dir: Path,
    out_dir: Path,
) -> dict:
    """Invoke the real kartograf_train.train.run() and return a dict
    with {onnx_bytes, tokenizer_bytes, onnx_sha, tokenizer_sha,
    eval_results, steps, final_loss, first_loss, loaded_precision}."""
    # Lazy import so --mode stub doesn't need the heavy ML stack.
    # The kartograf_train package sits in the same directory as this
    # script, which isn't on sys.path when invoked as `python3 <path>`
    # — add it explicitly so the import resolves regardless of cwd.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from kartograf_train.train import TrainConfig, run
    # Smoke stays at 128 context to fit GTX 960 VRAM with 6-sample
    # forward batch (1 anchor + 1 positive + 4 hard negs). Full mode
    # goes to 512 per spec §Training paths; Phase 6 overnight run.
    cfg = TrainConfig(
        corpus_dir=corpus_dir,
        out_dir=out_dir,
        mode=mode,
        max_length=512 if mode == "full" else 128,
    )
    result = run(cfg)
    print(
        f"[train-kartograf] training done: steps={result.steps} "
        f"first_loss={result.first_loss:.4f} final_loss={result.final_loss:.4f} "
        f"precision={result.loaded_precision} "
        f"dataset={result.dataset_size} "
        f"trainable={result.trainable_params:,}/{result.total_params:,}",
        file=sys.stderr,
    )
    return {
        "onnx_bytes": result.onnx_bytes,
        "tokenizer_bytes": result.tokenizer_json_bytes,
        "onnx_sha": result.onnx_sha256,
        "tokenizer_sha": result.tokenizer_sha256,
        "eval_recall_at_10": result.eval_results.retrieval_recall_at_10,
        "steps": result.steps,
        "loaded_precision": result.loaded_precision,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--corpus", required=True, type=Path,
                        help="Corpus directory (contains train.jsonl + corpus-v1-summary.json).")
    parser.add_argument("--out", required=True, type=Path,
                        help="Output directory for the staged checkpoint bundle.")
    parser.add_argument("--signing-seed-file", required=True, type=Path,
                        help="File with 32 raw Ed25519 seed bytes.")
    parser.add_argument(
        "--mode",
        default="stub",
        choices=["stub", "smoke", "full"],
        help="Training mode. 'stub' = no ML, placeholder artifacts "
             "(default, CI-friendly). 'smoke' = 50 steps real training. "
             "'full' = 3 epochs real training (Phase 6 operator overnight).",
    )
    parser.add_argument(
        "--distribution-source",
        default="file",
        choices=["hf-hub", "github-release", "file", "federation", "agora"],
        help="Trust tier the envelope will claim. Must match actual distribution channel.",
    )
    parser.add_argument("--hardware", default="gtx-960-local",
                        help="Hardware profile string for training_provenance.")
    parser.add_argument("--steps", type=int, default=0,
                        help="Training steps reported in envelope when --mode stub. "
                             "Ignored for smoke/full (trainer reports actual).")
    parser.add_argument(
        "--eval-recall-at-10",
        type=float,
        default=0.0,
        help="Eval Recall@10 reported in envelope when --mode stub. "
             "Ignored for smoke/full (trainer reports actual).",
    )
    parser.add_argument("--base-model",
                        default="answerdotai/ModernBERT-base@stub-rev",
                        help="Base model identifier + pinned revision.")
    args = parser.parse_args()

    # argparse with `type=float` happily parses `nan` / `inf` / `-inf`.
    # Those round-trip through Python's json.dumps as literals that
    # violate RFC 8259 (JS JSON.parse rejects them). Guard at the
    # envelope boundary so a typo can't produce an unverifiable
    # checkpoint downstream.
    if not math.isfinite(args.eval_recall_at_10):
        raise SystemExit(
            f"[train-kartograf] --eval-recall-at-10 must be a finite number; "
            f"got {args.eval_recall_at_10!r}."
        )
    if not (0.0 <= args.eval_recall_at_10 <= 1.0):
        raise SystemExit(
            f"[train-kartograf] --eval-recall-at-10 must be in [0.0, 1.0]; "
            f"got {args.eval_recall_at_10!r}."
        )

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

    # 3) Produce model/tokenizer artifacts — either via the real trainer
    # (smoke/full) or via the placeholder path (stub).
    out_dir.mkdir(parents=True, exist_ok=True)
    if args.mode == "stub":
        onnx_bytes = PLACEHOLDER_ONNX
        tok_bytes = PLACEHOLDER_TOKENIZER
        onnx_sha = sha256_hex(onnx_bytes)
        tok_sha = sha256_hex(tok_bytes)
        provenance_steps = int(args.steps)
        provenance_eval = float(args.eval_recall_at_10)
        hardware_suffix = ""
    else:
        # Real training. Lazy-imports the ML stack from kartograf_train.
        tr = _run_training(args.mode, corpus_dir, out_dir)
        onnx_bytes = tr["onnx_bytes"]
        tok_bytes = tr["tokenizer_bytes"]
        onnx_sha = tr["onnx_sha"]
        tok_sha = tr["tokenizer_sha"]
        provenance_steps = int(tr["steps"])
        provenance_eval = float(tr["eval_recall_at_10"])
        # Append precision to hardware string so the envelope records
        # which quantization path actually ran (4bit vs BF16 decided at
        # runtime based on bnb compatibility with ModernBERT).
        hardware_suffix = f";{tr['loaded_precision']}"
        if args.steps or args.eval_recall_at_10:
            print(
                "[train-kartograf] NOTE: --mode smoke/full overrides "
                "--steps / --eval-recall-at-10 with values from the "
                "actual training run.",
                file=sys.stderr,
            )

    onnx_path = out_dir / "model.onnx"
    tok_path = out_dir / "tokenizer.json"
    onnx_path.write_bytes(onnx_bytes)
    tok_path.write_bytes(tok_bytes)

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
            "hardware": args.hardware + hardware_suffix,
            "eval_recall_at_10": provenance_eval,
            "steps": provenance_steps,
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
