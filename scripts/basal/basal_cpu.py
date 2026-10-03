#!/usr/bin/env python
"""BASAL-1.0 typed decisions on CPU.

The upstream `basal-serve` requires CUDA (every mode is GraphBackend).
This host has a GTX 960 (compute_cap 5.2) which torch no longer ships
kernels for, so the server falls back to EagerBackend + bfloat16 on CPU.
Correct but slow — see /v1/systemone for per-request latency.

Categories are defined per request, not trained in. Confidence comes
from the model's own calibrated distribution.

This file is the source of truth. `scripts/install-basal.sh` copies it
into the install root; it did not live in the repo before, so a clean
host could never complete the install it advertised.
"""
import json, os, sys, time, threading
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "src"))
import torch

torch.set_num_threads(max(1, (os.cpu_count() or 4) - 1))

from basal.engine import EagerBackend
from basal.prompt import render, letter_ids
from fastapi import FastAPI, Request
import uvicorn

MODEL = os.environ.get(
    "BASAL_MODEL",
    os.path.join(os.path.expanduser("~"), ".cache/huggingface/hub/models--Remek--basal-1.0-1.5B/snapshots/81a74acc6e7f7604008697b2daa83b3652d85b68"),
)
PORT = int(os.environ.get("BASAL_PORT", "8000"))
DTYPE = os.environ.get("BASAL_DTYPE", "bfloat16")

app = FastAPI()
_state = {}

CAL = {}
_temps = {}


def _load():
    t0 = time.time()
    eng = EagerBackend(MODEL, dtype=DTYPE, device="cpu")
    cal_path = os.path.join(MODEL, "CALIBRATION.json")
    if os.path.exists(cal_path):
        with open(cal_path) as f:
            CAL.update(json.load(f))
        _temps.update(CAL.get("temperature_per_prim", {}))
    _state["eng"] = eng
    print(f"[basal] model={MODEL.split('/')[-1]} dtype={DTYPE} device=cpu "
          f"threads={torch.get_num_threads()} loaded in {time.time()-t0:.1f}s", flush=True)


# Load on import, not in the startup hook: a blocking loop inside
# on_event("startup") keeps uvicorn from ever binding the port, so
# /health was unreachable while the process was alive.
threading.Thread(target=_load, daemon=True).start()


def _decide(eng, state, question, options, orders=2, lang=None, qtype="choice"):
    """Typed decision: softmax over option letters, both orderings averaged.

    The per-question-type temperature from CALIBRATION.json is applied to
    the log-probabilities, exactly as basal/server.py:185 does. Without it
    the confidence values are NOT the calibrated ones, so the documented
    thresholds (0.93 / 0.74) do not mean what the model card says.
    """
    k = len(options)
    prompts, perms = [], []
    for perm in ([list(range(k)), list(range(k))[::-1]][:orders]):
        # Render the options IN THIS ORDER. Rendering the same list twice
        # makes both prompts identical, so the two "orderings" return the
        # same position-0 and position-1 probabilities and the canonical
        # average collapses to a 0.497/0.497 tie regardless of the model.
        prompts.append(render(eng.tok, state, question, [options[i] for i in perm], lang))
        perms.append(perm)
    lids = letter_ids(eng.tok, prompts[0], k)
    if lids is None:
        raise ValueError("option letters are not single tokens at the answer position")
    outs = eng.run(prompts, [lids] * len(prompts))
    # Canonicalise BEFORE averaging: engine.run returns probabilities in the
    # order the options were RENDERED, so position k of a run belongs to
    # option perm[k]. Averaging raw positions across the two orderings
    # cancels the model's signal — measured: loans scored 0.993 with one
    # ordering and came back as a 0.497/0.497 tie with two.
    canon = []
    for perm, pos in zip(perms, outs):
        c = [0.0] * k
        for i, j in enumerate(perm):
            c[j] = pos[i]
        canon.append(c)
    avg = [sum(vals) / len(canon) for vals in zip(*canon)]
    s = sum(avg) or 1.0
    probs = [v / s for v in avg]
    T = _temps.get(qtype, 1.0)
    if T != 1.0:
        import math
        logs = [math.log(max(p, 1e-12)) / T for p in probs]
        m = max(logs)
        e = [math.exp(v - m) for v in logs]
        t = sum(e) or 1.0
        probs = [v / t for v in e]
    return probs


@app.get("/health")
def health():
    ready = "eng" in _state
    return {"ok": True, "ready": ready, "model": "basal-1.0-1.5B",
            "device": "cpu", "dtype": DTYPE, "temperatures": _temps,
            "thresholds": CAL.get("thresholds", {})}


@app.post("/v1/systemone")
async def systemone(req: Request):
    body = await req.json()
    if "eng" not in _state:
        return {"ok": False, "error": "loading"}
    eng = _state["eng"]
    state = body.get("state", "")
    questions = body.get("questions", {})
    lang = body.get("lang")
    t0 = time.time()
    answers = {}
    for name, q in questions.items():
        typ = q.get("type", "choice")
        crit = q.get("criteria")
        if isinstance(crit, dict):
            options = [crit[k] for k in crit]
            keys = list(crit)
        else:
            options = crit
            keys = options
        probs = _decide(eng, state, q.get("instructions", ""), options,
                        orders=body.get("orders", 2), lang=lang, qtype=typ)
        pm = {keys[i]: probs[i] for i in range(len(keys))}
        if typ == "choice":
            best = max(range(len(keys)), key=lambda i: probs[i])
            answers[name] = {"type": "choice", "choice": keys[best],
                             "probabilities": pm, "confidence": probs[best]}
        elif typ == "noul":
            answers[name] = {"type": "noul", "noul": keys[int(round(probs[0] * (len(keys) - 1)))],
                             "probabilities": pm, "confidence": max(probs)}
        else:  # score: expected level 0..k-1
            exp = sum(i * probs[i] for i in range(len(keys)))
            answers[name] = {"type": "score", "score": exp,
                             "probabilities": pm, "confidence": max(probs)}
    return {"model": "basal-1.0-1.5B", "answers": answers,
            "usage": {"questions": len(questions), "output_tokens": 0,
                      "latency_ms": int((time.time() - t0) * 1000), "device": "cpu"}}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
