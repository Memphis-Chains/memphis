# LeWorldModel Integration Proposal

> **Status:** RESEARCH — operationalization spec, no production code.
> **Authors:** Wodzu (operator), Memphis Agent (Telegram), Claude Opus 4.7 (this doc)
> **Date:** 2026-05-05
> **Targets:** Y2 sprint (Q1-Q2 2027), prerequisites land in Y1
> **Scope:** wire LeWorldModel (15M JEPA, AMI Labs 2026) into the existing Memphis stack as a perception layer, reusing federation + chains + signed-block + memphis-ml infrastructure.

---

## TL;DR

LeWM is the **perception layer** Memphis is missing. Today the stack has:

- **Kartograf** (ModernBERT 150M) — semantic embedding for chains
- **Memphis chains** — append-only audit
- **Memphis-ML** — Lisp-like DSL + VM for hardware/agent logic
- **Federation Matrix (Y1 N14)** — private peer sync
- **Agora (Y2+ deferred)** — public market, CLI ready

LeWM (15M params, single-GPU trainable, action-conditioned latent prediction) plugs in **without inventing parallel infrastructure** — checkpoints ride the same federation/Agora primitives Kartograf uses, observations land in a new `world_model` chain audited by the existing signed-block protocol, and Memphis-ML programs gain a `(world-model-predict ...)` primitive in `ml-hal`.

This doc pins the shape so the Y2 sprint has a roadmap, not a brainstorm.

---

## 1. Why LeWM, why now

### 1.1 Theoretical fit

LeWM ([AMI Labs paper, 2026][lewm-paper]) hits a sweet spot Memphis has been missing:

| Property | Why it matters for Memphis |
|---|---|
| **15M parameters** | Trains single-GPU in hours on the operator's GTX 960 (4 GB VRAM). No cloud dependency. |
| **2-term loss (SIGReg)** | One effective hyperparameter. Eliminates the "needs ML PhD" barrier blocking earlier JEPA attempts (PLDM had 7 terms, O(n⁶) tuning). |
| **Latent prediction** | Avoids pixel-level prediction cost. Latents go straight to chains + Kartograf embeddings. |
| **Emergent VoE detection** | Violation-of-expectation = sharp prediction-error spike → directly auditable as a security/safety signal. |
| **End-to-end trainable** | Unlike DINO-WM (frozen encoder), latents adapt to operator's domain — own CNC sensors, own audio environment. |
| **Apache-2.0 / research-permissive** | Same license posture as Kartograf, fits Memphis sovereignty story. |

### 1.2 Concrete operator scenarios

The use cases hide in plain sight in operator's existing context (Wodzu runs a CNC shop with Efka/PFAFF controllers, plus voice + sensor pipelines):

1. **CNC anomaly detection.** Train LeWM on normal-operation sensor traces (vibration, current draw, position). VoE spike on a worn bearing or material slip → `voe_alert` chain entry → operator notified before a $5k spindle dies.
2. **Voice scene understanding.** Train LeWM on operator's daily audio environment (already partly captured for STT). VoE detects "unusual sound at 3am" = intrusion / fault / something to journal.
3. **Action-conditioned planning.** Memphis-ML programs query "if I send this G-code, what does the predicted-end-state latent look like?" → reject impossible plans before sending to controller.
4. **Cross-instance transfer.** Operator's Station LeWM checkpoint federates to their Nomad laptop via existing Matrix transport — same physical intuition on the road.

None of these require Memphis to build a new transport, signature scheme, or eval harness. They reuse what shipped in Y1.

---

## 2. Architectural placement

```
┌─────────────────────────────────────────────────────────────┐
│ Agora            (Y2+ deferred, --source agora CLI ready)  │
│   public market: stake + reputation + DHT                   │
├─────────────────────────────────────────────────────────────┤
│ Federation       (Y1 N14, src/federation/{mp,matrix})       │
│   Station ↔ Nomad private peer sync via Matrix HMAC         │
├─────────────────────────────────────────────────────────────┤
│ Memphis Chains   (shipped, 11 chains, signed-block gate)    │
│   journal · decisions · system · soul · cases · ...         │
│   + NEW world_model (this proposal)                         │
├─────────────────────────────────────────────────────────────┤
│ Memphis-ML       (~/memphis-ml, 10 crates, working VM)      │
│   DSL → bytecode → Rust VM, HAL drives hardware             │
│   + NEW ml-worldmodel (this proposal)                       │
├─────────────────────────────────────────────────────────────┤
│ LeWorldModel     (NEW: crates/memphis-worldmodel)           │
│   15M JEPA, ONNX inference, nightly retrain pipeline        │
├─────────────────────────────────────────────────────────────┤
│ Kartograf        (shipped v1.7.0-rc0)                       │
│   ModernBERT 150M, embedding + zone classifier              │
└─────────────────────────────────────────────────────────────┘
                         ↕
                    Hardware (GPIO/HTTP/MQTT via ml-hal)
                    Sensor stream (CNC, audio, IoT)
```

**Key invariant:** every new layer MUST piggyback on existing primitives. No parallel transport, no new chain types beyond `world_model`, no new signature scheme. Discipline matches `Y1 roadmap v3.1` rule 9: *"Kartograf distribution + sync rides federation primitives, no parallel transport."*

---

## 3. New components

### 3.1 `crates/memphis-worldmodel/`

Mirror of `crates/memphis-export/`'s structure (the .mv2 scaffold from PR #434), so existing operators recognize the layout.

```
crates/memphis-worldmodel/
├── Cargo.toml
└── src/
    ├── lib.rs           # public API
    ├── error.rs         # WorldModelError enum
    ├── encoder.rs       # ViT-Tiny encoder (~5M params)
    ├── predictor.rs     # ViT-S autoregressive predictor (~10M params)
    ├── sigreg.rs        # SIGReg loss term — sketched isotropic Gaussian regularizer
    ├── inference.rs     # ONNX runtime wrapper (re-uses onnxruntime-node)
    ├── voe.rs           # violation-of-expectation detector (KL divergence threshold)
    └── checkpoint.rs    # signed-block writer/reader (Ed25519 via memphis-core)
```

**Public API:**
```rust
pub fn encode(observation: &[f32]) -> Result<Latent, WorldModelError>;
pub fn predict(state: &Latent, action: &Action) -> Result<Latent, WorldModelError>;
pub fn voe_score(predicted: &Latent, observed: &Latent) -> f64;
pub fn load_checkpoint(path: &Path) -> Result<WorldModel, WorldModelError>;
pub fn publish_checkpoint(model: &WorldModel, signer: &Signer) -> Result<SignedBlock, WorldModelError>;
```

**Why a Rust crate, not Python:** matches operator-side runtime (no Python dependency for end users — same posture as Kartograf, Sprint H voice). Training pipeline uses Python (HF Transformers, see §5.1) but inference + signing are all Rust.

### 3.2 NAPI exports in `crates/memphis-napi/src/lib.rs`

Adds three exports following the Kartograf pattern:

```rust
#[napi] fn world_model_encode(observation: Vec<f64>) -> Result<Vec<f64>>;
#[napi] fn world_model_predict(state: Vec<f64>, action: Vec<f64>) -> Result<Vec<f64>>;
#[napi] fn world_model_voe(predicted: Vec<f64>, observed: Vec<f64>) -> Result<f64>;
```

TypeScript callers go through `src/infra/storage/rust-worldmodel-bridge.ts` (mirror of `rust-paths-bridge.ts`).

### 3.3 New chain: `world_model`

Schema added to Rust chain validator:

```jsonc
{
  "type": "world_model_observation",
  "data": {
    "sensor_id": "cnc-1.spindle.current",
    "timestamp_ms": 1714834217123,
    "raw_sample_hash": "blake3:...",
    "encoded_latent": [0.123, -0.456, ...],   // 192-d
    "predicted_latent": [0.140, -0.430, ...]  // from prior step
  }
}

{
  "type": "voe_alert",
  "data": {
    "sensor_id": "cnc-1.spindle.current",
    "kl_divergence": 4.7,
    "threshold": 2.0,
    "expected_action": "feed-rate-100",
    "observed_anomaly_window_ms": 250
  }
}

{
  "type": "world_model_checkpoint_published",
  "data": {
    "checkpoint_hash": "blake3:...",
    "trained_until_chain_index": 1234,
    "eval": { "perplexity": 2.31, "voe_recall_at_5": 0.87 },
    "promoted": true
  }
}
```

Both ride the existing `system` chain (per `Y1 roadmap v3.1` rule 10: "Kartograf checkpoint = signed block. Rides on existing `system` chain. No new chain type, no new schema." — same approach).

Wait — we need a separate `world_model` chain because the *observation* stream is high-volume (one entry per sensor sample at 10-100 Hz). Putting it on `system` would dwarf legitimate system events. **New chain: `world_model`** for observations + voe_alerts. Checkpoint-published events go on `system` (low-volume, audit-relevant), matching Kartograf's pattern.

### 3.4 Memphis-ML primitive: `ml-worldmodel` adapter

In `~/memphis-ml/crates/`, new crate parallel to `ml-hw-gpio`:

```
ml-worldmodel/
├── Cargo.toml
└── src/
    └── lib.rs
```

Exposes ML s-expr primitives:

```lisp
(world-model-encode (sensor "cnc-1.spindle.current"))
;; => #latent[0.123 -0.456 ...]

(world-model-predict
  #latent[0.123 ...]
  (action :feed-rate 100))
;; => #latent[0.140 ...]

(define (safe-action? state action)
  (let* ((predicted (world-model-predict state action))
         (voe (world-model-voe predicted state)))
    (< voe 2.0)))

(if (safe-action? current-state proposed-g-code)
    (hardware-send-gcode proposed-g-code)
    (memphis-decide "rejected: predicted physical violation"))
```

The crate calls into `crates/memphis-worldmodel/` via the existing FFI seam between memphis-ml and memphis-core (already used by `ml-memphis` for chain access).

### 3.5 CLI surface: `memphis worldmodel`

Mirror of `memphis kartograf {verify, install, status, query}` (already shipped in PR #436 + #452):

```bash
memphis worldmodel verify --file <envelope.json>
memphis worldmodel install --file <envelope.json> --source file
memphis worldmodel install --source hf-hub --as-baseline=true
memphis worldmodel install --source federation --peer <did> --force-active
memphis worldmodel install --source agora    # Y2+: returns "not implemented"
memphis worldmodel status
memphis worldmodel query --sensor "cnc-1.spindle.current" --window-ms 1000
```

Implementation: new `src/infra/cli/handlers/worldmodel.handler.ts` mirrors `kartograf.handler.ts` line-for-line. Same envelope verification, same install flow, same federation primitives. Doctor adds `ta14-worldmodel` check.

---

## 4. Federation hooks (zero new transport)

Per `Y1 roadmap v3.1` §federation, all sync paths are reused:

| Source | Y1 status | LeWM addition |
|---|---|---|
| `--source file` | shipped | works as-is — same envelope shape |
| `--source hf-hub` | Y1 N20 | works as-is — bucket added in HF org |
| `--source github-release` | Y1 | works as-is — release artifacts |
| `--source federation` | Y1 N14 (Matrix HMAC) | works as-is — same MP envelope |
| `--source agora` | Y2+ deferred | works as-is — `--source` flag wired today |

**No new code in `src/federation/`.** The MP envelope (in `src/federation/mp/envelope.ts`) is artifact-agnostic — it carries any signed block. Adding LeWM means adding a new `data.type` value to the validator's allowlist, no new transport.

---

## 5. Training pipeline

### 5.1 Initial training (operator one-shot)

```
crates/memphis-worldmodel/training/
├── train.py              # HF Transformers + bitsandbytes + LeWM SIGReg loss
├── corpus.py             # harvest sensor data from world_model chain
├── eval.py               # 100-trajectory regression set
└── export_onnx.py        # final → ONNX Runtime format
```

**Hardware budget on GTX 960 (4 GB):**
- ViT-Tiny encoder (5M) + ViT-S predictor (10M) = 15M params
- FP16 training: ~2.5 GB peak with gradient checkpointing
- Mixed-precision (BF16 if supported) + batch size 16 = realistic
- Single-GPU train time: ~2-4 hours for the AMI paper baseline; operator's domain corpus likely smaller, faster

**Coexistence with other GPU consumers:**
- LeWM training requires Whisper STT to be down (combined > 4 GB)
- Kartograf retrain (also nightly) and LeWM retrain MUST be scheduled sequentially, not concurrently
- Cron orchestration: `crons/nightly-retrain.sh` runs Kartograf first, then LeWM, then runs eval+promote, then re-enables STT

### 5.2 Nightly retrain (Watrowanie pattern, frozen)

Identical pattern to Kartograf nightly (see `docs/dev/KARTOGRAF-SPEC.md` §"Watrowanie nightly target"):

1. Harvest new chain deltas from `world_model` chain (filtered: corpus pipeline allowlist, secret-scan, denylist)
2. 70% static initial corpus + 30% recent deltas (catastrophic-forgetting guard)
3. LoRA retrain 1 mini-epoch from active checkpoint
4. Eval against frozen 500-trajectory regression set
5. Promote only if new ≥ active (ε=0)
6. Atomic swap `~/.memphis/worldmodel/active.onnx` symlink
7. Audit to `system` chain `data.type='world_model_checkpoint_published'`

Same eval-gate mechanism. Same promote/rollback discipline.

---

## 6. Use case proof: CNC anomaly detection demo

End-to-end walkthrough operator can run after Y2 ship:

```bash
# 1. Bootstrap: collect normal-operation sensor traces for 1 week
memphis worldmodel record --sensor "cnc-1.spindle.current" --duration 7d
# Writes to world_model chain at ~10 Hz, ~6M samples / week

# 2. Train initial model
memphis worldmodel train --baseline-corpus ~/.memphis/world_model
# Single-GPU, ~3h on GTX 960

# 3. Verify via eval set
memphis worldmodel verify --eval ~/.memphis/world_model/eval-set.json
# perplexity: 2.31, voe_recall@5: 0.87

# 4. Activate (atomic symlink swap)
memphis worldmodel install --file ~/.memphis/world_model/checkpoint-2027-Q1.envelope.json \
                          --source file --force-active

# 5. Run live with VoE alerts to a chain-watching agent
memphis tui  # Ctrl-Shift-W opens "world model" panel showing live latent + VoE score

# 6. Federate to Nomad laptop
memphis federation peer add --did did:memphis:nomad-1
memphis worldmodel publish --source federation --peer did:memphis:nomad-1
# Nomad receives signed checkpoint, verifies signer, --as-baseline=true (operator must --force-active to promote)
```

---

## 7. Sequencing — what blocks what

```
Y1 (2026-05 → 2027-04)               PRE-REQS for Y2 LeWM sprint:
  Q1: Kartograf v1 + .mv2 export ✅ (done)
  Q2: Federation N14 (Matrix HMAC peer sync)         ← REQUIRED
  Q3: Watrowanie nightly retrain pipeline (Kartograf) ← REQUIRED (proves cron+gate+swap)
  Q4: Kartograf v2 (multi-head — Wodzu deferred)

Y2 (2027-05+)                         LeWM sprint:
  Q1: crates/memphis-worldmodel + NAPI + chain schema (~2 weeks)
  Q1: ml-worldmodel adapter + s-expr primitives (~1 week)
  Q2: Initial training pipeline + eval harness (~2 weeks)
  Q2: CLI handler + doctor check + runbook (~1 week)
  Q3: First operator-trained checkpoint, federation demo
  Q4: Agora flag wiring (still returns "Y3+ deferred"; surface ready)
```

**Hard dependencies (won't ship without):**
- Y1 N14 federation: needed for `--source federation` to work
- Y3 Watrowanie pipeline: nightly retrain reuses identical primitives
- Y1 signed-block validator: already shipped, just adds new `data.type` allowlist

**Soft dependencies (better with, fine without):**
- Q3 cron-orchestration framework — without it, retrain runs as a manual cron entry
- Sprint G `crons/spac.sh` decision — sets the precedent for cron entry conventions

---

## 8. Sovereignty / grant story

Memphis already has a clean local-first narrative for Kartograf. Adding LeWM strengthens it:

| Layer | Sovereignty claim |
|---|---|
| Kartograf | "your text knowledge stays local, federates only between your machines" |
| **LeWM (new)** | **"your *physical* knowledge — what your machines look like under your floor — never leaves the box"** |
| Memphis-ML | "your agents speak a sovereign language compiled to a Rust VM, not a chatGPT API" |
| Chains | "every observation, every prediction, every action is hash-linked + signed by you" |
| Federation | "if you choose to share, it's peer-to-peer with explicit trust, not via a central server" |

For impakt grant: this is **the first published self-supervised physical-intuition system that runs entirely on consumer GPU under operator control, with cryptographic provenance**. The combination is the differentiator — neither LeWM alone nor Memphis alone has it.

The technical risk is concentrated in Y2 Q1-Q2 (model training stability on diverse sensor domains). Mitigations: ride the AMI paper's exact recipe for the v1 release; allow `--source` ingest of community-trained checkpoints as a baseline.

---

## 9. Out of scope (explicit)

To prevent Y2 scope creep:

- **Multi-modal fusion** (vision + audio + sensor in one model) — Y3+
- **RL on top of world model** — Y3+, deferred
- **Differentiable physics simulator integration** — never (different problem)
- **Cloud training tier** — operator can use cloud HF Trainer for v1 if local fails, but no managed service
- **Real-time control loops faster than 10 Hz** — Memphis's current architecture is not RT; this is a research model, not a robot controller

---

## 10. Decision matrix for operator

When this Y2 sprint opens, operator picks ONE concrete use case to demo first. The crate ships generic, the demo proves it.

| Use case | Sensor source | Why pick first | Why skip first |
|---|---|---|---|
| CNC anomaly detection | Efka/PFAFF controllers (already in operator's environment) | Concrete user, concrete cost saving (spindle replace), grant-ready | Real-world chaos; harder to bound the corpus |
| Voice scene VoE | Whisper-aligned audio capture | Re-uses existing voice pipeline, low integration cost | Less differentiated story; voice anomaly is well-trodden territory |
| Memphis-ML action planning | Synthetic GPIO test rig | Cleanest demo, shortest path to working code | Toy-domain optics; weak grant story |

Recommendation: **CNC anomaly first** — it's the differentiator that no off-the-shelf product nails for shop-floor operators in Poland.

---

## Open questions

These are deliberately left open for the Y2 sprint kickoff:

1. **Can ONNX Runtime export both the encoder + autoregressive predictor cleanly?** AMI paper uses PyTorch; the autoregressive loop with KV-cache is what tripped earlier ONNX exports of similar architectures. Fallback: keep training in PyTorch + `torch.jit.script` the inference loop, ship the JIT artifact; only the encoder ONNX-exported.
2. **Which sensor schema becomes the v1 reference?** Need a canonical encoding so federation receivers can validate (e.g. operator A's CNC schema isn't the same as operator B's — does federation transfer help or just confuse?). Likely: per-domain checkpoints, no cross-domain transfer in v1.
3. **VoE threshold calibration.** Per-sensor or global? Static or learned from quantile of training-set residuals? Y2 spike question.
4. **Storage cost.** 10 Hz × 192-d × 8 bytes × 86400 s = ~1.3 GB/day for one sensor. Need rotation policy on `world_model` chain (keep 7 days raw, then summary).

---

## References

- LeWorldModel paper (AMI Labs, 2026). Local copy at `~/.openclaw/workspace/research/AMI_Labs_LeWorldModel.md` (operator brainstorm, 2026-05-04).
- Memphis-ML repo: `~/memphis-ml/` (Memphis-Chains/memphis-ml on GitHub).
- Kartograf spec (frozen): `docs/dev/KARTOGRAF-SPEC.md`.
- Federation Matrix design: `MEMPHIS-FEDERATION-DESIGN.md` + `src/federation/mp/`.
- Y1 roadmap v3.1: `docs/roadmap/Y1-2026-05-to-2027-05.md`, especially §federation rules 9-12.
- Existing crate template: `crates/memphis-export/` (PR #434 — .mv2 scaffold).

[lewm-paper]: https://arxiv.org/abs/2026.XXXXX  "AMI Labs LeWorldModel — placeholder, replace with real arxiv id when available"
