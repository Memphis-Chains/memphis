#!/usr/bin/env python
"""BASAL-1.0 typed decisions on CPU.

The upstream `basal-serve` requires CUDA (every mode is GraphBackend).
This host has a GTX 960 (compute_cap 5.2) which torch no longer ships
kernels for, so the server falls back to EagerBackend + bfloat16 on CPU.
Correct but slow — see /v1/systemone for per-request latency.

Backends (BASAL_BACKEND=gguf|torch, default auto):
  torch — EagerBackend, bfloat16, the original safetensors weights.
  gguf  — llama.cpp Q8_0, same weights quantised, full-vocabulary logits.
Measured on this host, one question, four options, orders=1:
  torch  99 s   (0.954 Wrzesień 2026)
  gguf   19 s   (0.879 Wrzesień 2026)
Same answer, 5.2x faster, identical across repeated runs. "auto" prefers gguf
when the file is there and silently falls back to torch when it is not or
does not load, so a partial install still serves.

NOT the upstream `ollama` mode: Ollama caps top_logprobs at 20 and this
model puts the rejected option letters below that, so a legitimate answer
comes back incomplete. `format: gguf` in /api/show is also always true on
Ollama >= 0.23 because it converts safetensors to GGUF on import, which
defeats upstream's own safetensors check. gguf via llama.cpp has neither
limit and returns the complete distribution.

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
from basal.prompt import MAX_OPTIONS
from fastapi import FastAPI, HTTPException, Request
import uvicorn

MODEL = os.environ.get(
    "BASAL_MODEL",
    os.path.join(os.path.expanduser("~"), ".cache/huggingface/hub/models--Remek--basal-1.0-1.5B/snapshots/81a74acc6e7f7604008697b2daa83b3652d85b68"),
)
PORT = int(os.environ.get("BASAL_PORT", "8000"))
DTYPE = os.environ.get("BASAL_DTYPE", "bfloat16")
# The HF snapshot directory holds the tokenizer, config and CALIBRATION.json
# that gguf mode still needs; only the weights come from the .gguf file.
BASAL_HOME = os.path.dirname(os.path.abspath(__file__))
GGUF = os.environ.get("BASAL_GGUF", os.path.join(BASAL_HOME, "models", "gguf", "basal-1.0-1.5B-Q8_0.gguf"))
BACKEND = os.environ.get("BASAL_BACKEND", "auto").lower()
THREADS = int(os.environ.get("BASAL_THREADS", "3"))
CTX = int(os.environ.get("BASAL_CTX", "2048"))

app = FastAPI()
_state = {}

CAL = {}
_temps = {}


class GgufBackend:
    """llama.cpp on the same checkpoint, quantised to Q8_0.

    Exposes the same surface _decide() uses: a tokenizer and a run()
    that maps prompts + letter token ids to per-prompt probabilities.
    llama.cpp exposes the full logit row, so every option letter is
    readable even when the model is very confident and the rejected
    letters fall outside any top-k list.
    """

    def __init__(self, model_dir, gguf_path, n_threads=None, n_ctx=None):
        from llama_cpp import Llama
        from transformers import AutoTokenizer

        self.tok = AutoTokenizer.from_pretrained(model_dir)
        self.llm = Llama(
            model_path=gguf_path,
            n_ctx=n_ctx or CTX,
            n_threads=n_threads or THREADS,
            logits_all=True,
            verbose=False,
        )
        self.dev = "cpu"
        self.gguf = gguf_path

    def run(self, prompts, ids_list):
        import math

        out = []
        for prompt, ids in zip(prompts, ids_list):
            toks = self.llm.tokenize(prompt.encode())
            self.llm.reset()
            self.llm.eval(toks)
            row = self.llm.scores[self.llm.n_tokens - 1]
            # scores are raw logits, so normalise across the option
            # letters only — the same softmax over the letter logits the
            # torch path takes.
            lps = []
            for i in ids:
                v = row[i]
                if v is None:
                    raise ValueError("option letter has no logit in the gguf vocabulary")
                lps.append(float(v))
            m = max(lps)
            ex = [math.exp(v - m) for v in lps]
            s = sum(ex) or 1.0
            out.append([v / s for v in ex])
        return out


def _load():
    t0 = time.time()
    want = BACKEND
    if want == "auto":
        want = "gguf" if os.path.exists(GGUF) else "torch"
    eng = None
    if want == "gguf":
        try:
            eng = GgufBackend(MODEL, GGUF)
        except Exception as exc:  # noqa: BLE001 - any failure must degrade, not kill the server
            print(f"[basal] gguf backend unavailable ({exc}); falling back to torch", flush=True)
            eng = None
    if eng is None:
        try:
            eng = EagerBackend(MODEL, dtype=DTYPE, device="cpu")
        except Exception as exc:  # noqa: BLE001 - degrade, do not kill the loader
            # Unguarded, a failed torch fallback kills the loader thread:
            # _state["eng"] is never set and the unit stays `active` for ever
            # reporting ready:false with nothing in the log saying why. Print
            # it and let /health answer false so memphis_classify returns its
            # structured "unreachable" error with the start command.
            print(f"[basal] torch backend unavailable ({exc}); service degraded to ready=false", flush=True)
            return
    cal_path = os.path.join(MODEL, "CALIBRATION.json")
    if os.path.exists(cal_path):
        with open(cal_path) as f:
            CAL.update(json.load(f))
        _temps.update(CAL.get("temperature_per_prim", {}))
    _state["eng"] = eng
    kind = "gguf" if isinstance(eng, GgufBackend) else "torch"
    print(f"[basal] model={MODEL.split('/')[-1]} backend={kind} dtype={DTYPE} device=cpu "
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
    eng = _state.get("eng")
    ready = eng is not None
    return {"ok": True, "ready": ready, "model": "basal-1.0-1.5B",
            "backend": "gguf" if isinstance(eng, GgufBackend) else ("torch" if ready else "none"),
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
        # Validate ahead of the model, not after. Their prompt.py raises a
        # bare IndexError on the 11th option, which is indistinguishable from
        # an unrelated IndexError raised by render itself — catching it would
        # swallow real faults. Counting here also avoids spending 70-140 s of
        # CPU inference only to report that the input was never valid.
        #
        # The same guard exists on our side (src/mcp/tools/classify.ts,
        # crates/memphis-operator/src/chat.rs); this one covers the endpoint
        # being reachable by anything that speaks HTTP, curl included.
        if len(options) > MAX_OPTIONS:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"basal-1.0 supports at most {MAX_OPTIONS} options, got "
                    f"{len(options)}. The models are calibrated on the A-J "
                    "lettered format; extra options cost accuracy rather than "
                    "adding discriminating power."
                ),
            )
        try:
            probs = _decide(eng, state, q.get("instructions", ""), options,
                            orders=body.get("orders", 2), lang=lang, qtype=typ)
        except ValueError as exc:
            # letter_ids() raises ValueError when an option letter is not a
            # single token at the answer position — also a caller error.
            raise HTTPException(status_code=400, detail=str(exc)) from exc
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
                      "backend": "gguf" if isinstance(eng, GgufBackend) else "torch",
                      "latency_ms": int((time.time() - t0) * 1000), "device": "cpu"}}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
