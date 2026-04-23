# Kartograf — technical specification (v1)

> **Status.** Binding 2026-04-23 (Y1 Q1 N36). Locks architectural decisions for Q2 implementation (N32, N21, N40) and Q3 Watrowanie target (N26) + federation sync (N41). Supersedes `docs/dev/WATRA-*.md`.
>
> **Target release.** Kartograf v1.0.0 ships in Q2 (target v1.7.0). Y1 scope: two heads (embedding + zone), ONNX runtime, local training default.

## Role (locked)

Kartograf is a **Memphis-native mini-model** that:
- Produces 256-dimensional **dense embeddings** for chain retrieval (replacing generic `nomic-embed-text` as tier-0 of the embed cascade).
- Emits a 12-class **zone distribution** (10 live chains + 2 reserved) that routes natural-language queries to the correct Memphis chain (subsumes the old Watra pointer-service design).
- Runs **in-process** via `onnxruntime-node` (no Python runtime required at operator install).
- Fits **4 GB VRAM / 500 MB RAM** at inference — shares hardware with Ollama LLM without requiring a dedicated card.

**What Kartograf is NOT:**
- Not a language model (no generation head in Y1 — advisory head deferred to Y2).
- Not an authoritative safety gate (advisory only — hard blocks stay path-based in `src/mcp/tools/self-modify.ts`).
- Not a tool invoker (classifier output, no action-taking).
- Not a federated-training peer (cross-operator training explicitly Y2+).

## Scaffold

| Property | Value |
|---|---|
| Base model | `answerdotai/ModernBERT-base` |
| License | Apache-2.0 |
| Params | ~150M |
| Context | 8192 tokens (native, no RoPE extension needed for Memphis corpus) |
| Architecture | Encoder-only BERT-variant with RoPE + GeGLU + local/global attention |
| Revision pin | Exact HF commit hash recorded in `tools/training/MODELCARD.md` at training time |

**Why ModernBERT:** encoder-only (we need embeddings, not generation), recent (2024-12, still maintained), fast on CPU (important for operators without GPU), Apache-2.0 (no license risk), supports multi-head fine-tune cleanly.

**Excluded alternatives:**
- `all-minilm-l6-v2` — too small (22M) for 12-class classification head.
- `nomic-embed-text` — already available via Ollama; we want domain-tuning not generic replacement.
- `Qwen3-0.6B` — language model, not encoder; generation overhead we don't need.
- `BERT-base-uncased` — older architecture, slower, no 8k context.

## Heads (v1, two only)

One forward pass → two output tensors:

### Head 1: dense embedding (256d, L2-normalized)

- Applied over `[CLS]` token final hidden state with a projection layer `Linear(768 → 256)`.
- L2-normalized at output so cosine similarity = dot product.
- Trained via InfoNCE contrastive loss. Positive pairs from co-occurrence in git commits + lexically/semantically similar Memphis symbols. Hard negatives from different zones.

### Head 2: zone logits (12 classes — aligned with canonical chain catalog)

- Applied over `[CLS]` token with `Linear(768 → 12)` + softmax at inference.
- Classes (first 10 map 1:1 to live chains in `src/memory/chain-catalog.ts`; last 2 are reserved slots):

  1. `journal`
  2. `decisions`
  3. `reflections`
  4. `cases`
  5. `patterns`
  6. `system`
  7. `collective`
  8. `proactive`
  9. `insights`
  10. `soul`
  11. `reserved_1`
  12. `reserved_2`

- **Chain additions without full retrain:** a new chain takes one reserved slot — zone-classifier head is fine-tuned on the added label while encoder + embedding head stay frozen. After 2 additions (reserved slots exhausted), next chain addition requires full zone-head retrain (not full-model retrain — still cheap).
- **Schema alignment is mandatory.** Implementation reads canonical chain list from `src/memory/chain-catalog.ts` at corpus build time and asserts first 10 zone classes equal that list. Catalog drift between spec + code fails corpus build, not silently.
- Trained via cross-entropy on auto-labeled corpus.

### Deferred heads (Y2, NOT v1)

Per `memory/kartograf_spec_frozen.md` v3.1:
- `mutability_score` (regression from `git log` age).
- `operator_facing` (binary).
- `safety_boundary` (BCE on invariant docs).
- `subsystem_confidence` (classifier entropy proxy).
- Advisory generator head (~5M params, bounded-length retrieval-grounded text).

Y2 can add without retokenizing: encoder weights stay, heads are swapped. Memphis runtime detects checkpoint head set and gracefully uses what's present.

## Multi-task loss (v1)

```
L = λ1 * InfoNCE(embedding_output)   + λ2 * CE(zone_logits, zone_label)
```

- `λ1 = 1.0`, `λ2 = 0.5` (initial; tuned during Q2 eval cycle).
- No orthogonality penalty needed in v1 (only 2 heads, both over `[CLS]` projection; no cross-talk expected).
- No regularization on free dims (only embedding + zone; all dims supervised).

Y2 expansion (5 heads) will need orthogonality penalty between supervised slots and free contrastive dims per earlier `kartograf_spec_frozen.md` design.

## Training corpus

Sourced by `tools/training/kartograf-corpus.py` (N37 Q1). Full spec separate; summary:

1. **Path allowlist** (only these paths enter corpus):
   - `src/**/*.{ts,rs}`
   - `crates/**/*.rs`
   - `docs/**/*.md`
   - `tests/**/*.ts`
   - `~/.memphis/chains/<chain>/*.json` — Memphis stores each block as an individual JSON file under a per-chain directory (see `src/infra/storage/chain-file-io.ts` + `src/infra/memory/embed-reindex.ts`). Corpus builder iterates every known chain name from `src/memory/chain-catalog.ts` and globs `*.json` per directory.
   - `~/.memphis/config/{ISKRA,PULSE}.md` (operator identity)
2. **Denylist** (hard refuse):
   - `~/.memphis/vault/**`
   - `.env*`
   - `**/secrets/**`
   - `**/.memphis-backup*/**`
3. **Secret-pattern scan** — same regex set as `scripts/secret-scan.sh` (AKIA, AIza, ghp_, sk-ant-, xox[baprs]-, JWT, PEM blocks, `api[_-]?key=...`). Any match → sample rejected + logged.
4. **Zone auto-label** — path heuristics:
   - `src/security/**`, `crates/memphis-vault/**` → `system` (and future Y2 head: safety_boundary high)
   - `src/memory/**`, `src/core/decision-chain.ts` → `decisions`
   - `src/cognitive/**` → `reflections`
   - `src/gateway/**`, `src/mcp/tools/**` → `system`
   - `docs/**` → `docs` (mapped to `system` zone in v1; dedicated docs zone is Y2)
   - `tests/**` → `system` (test infra mapped to system zone in v1; dedicated test zone is Y2)
5. **Teacher distillation** (ambiguous files only) — Anthropic API call via existing `src/providers/anthropic/`, returns zone label + confidence. Budget ~$10-50 one-off. Cached to disk.
6. **Pair generation** — contrastive positives from git co-occurrence + symbol similarity; hard negatives cross-zone.

**Corpus output:** `~/.memphis/kartograf/corpus/v1/{train,eval}.jsonl + zone-labels.json + license-audit.json + corpus-v1-summary.json`. Summary file proves invariants.

## Training paths

Two paths, decision gate at end of Q2 week 2:

### Path A (default, local)

- Hardware: GTX 960 4GB VRAM + i3-2120 + 16GB RAM
- Config (empirically verified 2026-04-22 on Qwen2.5-0.5B, carries to ModernBERT):
  - BF16 (FP16 crashes gradient scaler on this torch)
  - LoRA rank 8, alpha 16 on q/k/v/o projections (not full-parameter — 4GB is tight)
  - Full-train multi-task heads (only ~200K params, fits easily)
  - `batch_size=4-8` via gradient accumulation (real per-step = 1)
  - `max_length=512` (Memphis chunks never exceed; 8k context is reserved for inference)
  - `peft 0.13.2` (0.19+ requires torch 2.11+, unavailable)
  - `bitsandbytes` 4-bit for base weights (fits base in ~1GB)
- Wall clock: ~4-8h overnight × 3 epochs
- Cost: $0

### Path B (cloud escape)

- Triggers: Path A v0.1 eval misses threshold (`retrieval_p@10 < 0.6` OR `zone_accuracy < 80%`)
- Hardware: H100 spot instance via RunPod/Vast.ai
- Config: full-parameter fine-tune, FP16, `batch_size=32`, gradient checkpointing
- Wall clock: ~2-4h
- Cost: $20-100 one-off

Path B is not the default — sovereignty principle. Cloud activates only on accuracy failure.

## ONNX export

Post-training merge + export:
1. Merge LoRA adapter back into base weights.
2. Export to ONNX via `torch.onnx.export(..., opset_version=17)`.
3. Variant A: FP16 (~300MB on disk).
4. Variant B: INT8 quantized via `onnxruntime.quantization` (~80MB).

Both ship together. Operator `kartograf doctor` picks based on hardware (GPU → FP16; weak CPU → INT8).

## Runtime (onnxruntime-node)

Inference lives in TypeScript via `onnxruntime-node` (Apache-2.0 npm, `stable-platform` per dep policy).

### Session lifecycle

```ts
// src/kartograf/session.ts (Q2 N32)
import { InferenceSession } from 'onnxruntime-node';

let session: InferenceSession | null = null;

export async function init(modelPath: string, preferGpu = true): Promise<void> {
  const executionProviders = preferGpu ? ['cuda', 'cpu'] : ['cpu'];
  session = await InferenceSession.create(modelPath, { executionProviders });
  // Warmup query — forces kernel compilation + exposes early failures
  await embed('__warmup__');
}

export async function embed(text: string): Promise<StructuredEmbedding> {
  if (!session) throw new KartografUnavailableError('not initialized');
  const tokens = tokenize(text);
  const feeds = { input_ids: tokens.ids, attention_mask: tokens.mask };
  const out = await session.run(feeds);
  return {
    vector: Float32Array.from(out.embedding.data),
    zones: decodeZones(out.zone_logits),
  };
}
```

### Tokenizer

- ModernBERT ships a standard `tokenizer.json` (HuggingFace tokenizers format).
- Memphis loads via `@huggingface/jinja` + `tokenizers` npm packages — both `stable-platform`.

### Per-query budget

- Max wall clock: 5 seconds (graceful timeout → fallback to cascade tier 1).
- Max memory: checked via `process.memoryUsage().rss`; if > 1.5GB after 100 queries, dispose + reinit session.
- Circuit breaker: 3 consecutive failures → disable for 5 min.

### Doctor integration

`memphis doctor --json` exposes:

```json
{
  "kartograf": {
    "installed": true,
    "version": "1.0.0",
    "checkpoint_sha256": "abc123...",
    "session_initialized": true,
    "warmup_test_passed": true,
    "execution_provider": "cuda",
    "last_query_latency_ms": 142,
    "p99_latency_ms_24h": 180,
    "circuit_breaker_state": "closed",
    "tier0_eligible": true
  }
}
```

## Cascade integration (Q2 N21)

Post-Kartograf ship, embedding cascade becomes:

```
Tier 0: Kartograf (domain-tuned, zone-aware)            ← Q2
Tier 1: Ollama(nomic-embed-text)    (quality fallback)
Tier 2: Ollama(all-minilm)          (smaller fallback)
Tier 3: GenericOpenAIProvider       (remote opt-in)
Tier 4: LocalDeterministic          (last resort)
```

`EmbedMode::Cascade(Vec<EmbedMode>)` variant added to `crates/memphis-embed/src/pipeline.rs` (N21). TS wrapper in `src/infra/storage/rust-embed-adapter.ts` attempts Kartograf first; cascade fallback on error.

**Dimension migration:** Kartograf = 256d; existing `nomic-embed-text` indexes = 768d; `LocalDeterministic` = 32d. Existing indexes stay queryable via dimension-aware lookup; operators can run `memphis kartograf reindex` to rebuild native-256d HNSW.

## Pointer emission (zone → chain routing)

CLI + tool surface per roadmap N32:

```ts
// src/kartograf/pointer.ts
export const Pointer = z.object({
  // Canonical chain list (10 live chains from src/memory/chain-catalog.ts).
  // Reserved zone slots are NEVER emitted as pointer.chain — they resolve
  // via the mapping rule below to a best-effort real chain, or the pointer
  // is marked unresolved.
  chain: z.enum([
    'journal', 'decisions', 'reflections', 'cases', 'patterns',
    'system', 'collective', 'proactive', 'insights', 'soul',
  ]),
  selector: z.string(),
  confidence: z.number().min(0).max(1),
  // When true, zone classifier picked a reserved slot or fell below
  // confidence threshold. Caller should treat `chain` as advisory and
  // consult `alternatives` first.
  unresolved: z.boolean().default(false),
  alternatives: z.array(
    z.object({
      chain: z.string(),
      selector: z.string(),
      confidence: z.number(),
    }),
  ).optional(),
  embedding: z.instanceof(Float32Array),
  timestamp: z.string(),
});
```

**Reserved-slot mapping rule** (applies when argmax = `reserved_1` or `reserved_2`):
1. Take argmax from the **real-chain subset** (zones 1-10 only) → assign to `chain`.
2. Set `unresolved: true`.
3. Populate `alternatives` with top-3 real chains + the reserved slot (so operator sees the model's intent).
4. Log one `system` chain entry `data.type='kartograf_reserved_slot_hit'` with full logits for later retraining signal (reserved slots hitting on real content = new chain type demand).

This keeps the pointer schema closed over live chains (stable callers) while preserving full information about classifier uncertainty.

- `chain` = argmax over real-chain subset (slots 1-10); reserved slots trigger `unresolved: true` per rule above.
- `confidence` = softmax peak across ALL 12 classes (not renormalized over the 10 real chains — raw signal).
- `selector` = keyword/phrase extraction (Y1: simple top-5 tokens by TF-IDF against corpus vocab; Y2: learned via third head).
- Low-confidence floor: if `confidence < 0.5`, set `unresolved: true` and populate `alternatives` regardless of argmax.
- `confidence` = softmax peak.
- Exposed via:
  - CLI: `memphis kartograf query "<text>" --json`
  - Tool registry: `memphis_kartograf_pointer` (tier-0 read)

## Distribution trust tiers

Kartograf checkpoint distribution mirrors federation trust model (`docs/roadmap/Y1-2026-05-to-2027-05.md` non-negotiables #9-12):

| Source flag | Tier | Trust basis | Y1 status |
|---|---|---|---|
| `--source hf-hub` | public official | SHA256 manifest + org reputation | Q2 ship |
| `--source github-release` | public CDN | SHA256 manifest + GH release signature | Q2 ship |
| `--source file` | out-of-band | SHA256 + Ed25519 envelope (N40) | Q2 ship |
| `--source federation` | private peer | Matrix + HMAC (N14) + Ed25519 envelope | Q3 ship (N41) |
| `--source agora` | public marketplace | Agora 4-layer trust | **Y2+** (returns explicit Y2+ error in Y1, not silent fallback) |

Same flag shape for `publish --to`.

**Public → private contamination guard (non-negotiable #11):** public-source installs default `--as-baseline=true` (stored under `~/.memphis/kartograf/baselines/<sha>/`, not promoted to active). Explicit `--force-active` required to swap. Locally-tuned checkpoints (from Watrowanie or federation sync) outrank public releases unless eval proves otherwise.

## Checkpoint envelope (N40 Q2)

Every Kartograf checkpoint (from training, download, or federation sync) is a first-class signed artefact:

```json
{
  "version": "1.0.0",
  "base_model": "answerdotai/ModernBERT-base@<revision>",
  "onnx_sha256": "<hex>",
  "tokenizer_sha256": "<hex>",
  "heads_config": {
    "embedding_dim": 256,
    "zone_classes": 12,
    "zone_taxonomy_version": 1
  },
  "training_provenance": {
    "corpus_version": "v1",
    "corpus_sha256": "<hex>",
    "training_path": "A" | "B",
    "hardware_profile": "gtx-960-4gb" | "h100-spot",
    "eval_results": { ... }
  },
  "signer_did": "did:memphis:<pubkey>",
  "signature": "<base64 Ed25519 sig over canonical JSON minus signature field>",
  "timestamp": "2026-XX-XXT..."
}
```

Signed via existing `crates/memphis-core/src/signature.rs` keypair (same signer as chain blocks). Publication writes a `system` chain block with `data.type='kartograf_checkpoint_published'` carrying the envelope — no new chain type.

Verification on install:
1. Parse envelope; reject if missing required fields.
2. Verify Ed25519 signature over canonical JSON.
3. Verify `onnx_sha256` against downloaded file.
4. Verify `tokenizer_sha256`.
5. Verify `base_model` pin matches expected revision (operator can override with warning).
6. Reject on any mismatch; actionable error; atomic swap only after all checks pass.

## Safety oracle (N38 Q3, advisory only)

`src/safety/kartograf-advisor.ts` wraps 4 destructive ops:
- `memphis_self_modify`
- `memphis_fs_write`
- `memphis_deploy`
- `memphis_cron set|delete`

Before execution, advisor calls `kartograf.embed(target)` and emits stderr warning if `zone_logits[system]` > 0.7 AND path matches `src/security/**` OR `crates/memphis-vault/**`. Warning is NON-BLOCKING — hard gates stay path-based in `src/mcp/tools/self-modify.ts` (existing code unchanged).

Logs to `system` chain with `data.type='security_advisory'` — no new chain type.

## Eval protocol (Q2 gate)

500-query held-out eval set:
- 300 retrieval queries (known query→relevant-chunk pairs)
- 200 zone classification queries (query → expected chain), stratified: 20 per live chain × 10 chains = 200 (reserved slots not evaluated directly since no real content hits them at release).

Metrics:
- **Retrieval P@10** ≥ 0.75 (v1.0 target)
- **Zone classification accuracy** ≥ 0.90 (v1.0 target)
- **Zone confidence calibration (ECE)** < 0.05
- **Latency p99** < 200ms on GTX 960 FP16

Failure threshold for Path A → Path B:
- `retrieval_p@10 < 0.6` OR `zone_accuracy < 0.80`

Eval set lives at `~/.memphis/kartograf/corpus/v1/eval.jsonl` (generated alongside train by `kartograf-corpus.py`). Frozen for the lifetime of v1 — used as regression guard by Watrowanie nightly.

## Hardware envelope

| Deployment | VRAM | RAM | Latency target |
|---|---|---|---|
| GTX 960 4GB FP16 | ~350MB | ~500MB | < 200ms |
| CPU-only (i3-class) FP16 | — | ~500MB | < 500ms |
| CPU-only INT8 | — | ~150MB | < 250ms |
| Cloud (A10/H100) FP16 | any | — | < 50ms |

Coexists with Ollama (e.g. `qwen2.5:7b-instruct` Q4_K_M ~4.5GB) on same GPU via existing provider cascade unload/reload logic.

## Watrowanie nightly target (Q3 N26)

Per `memory/watrowanie_nightly_spec_frozen.md`, Kartograf replaces Watra as retrain target. Every-other-night cycle:
1. Harvest new chain deltas (filtered by corpus pipeline — same allowlist/denylist/secret-scan).
2. 70/30 mix: 70% static v1 corpus + 30% new deltas (catastrophic-forgetting guard).
3. LoRA retrain 1 mini-epoch from active checkpoint.
4. Eval against frozen 500-query set.
5. Promote only if new checkpoint ≥ active (ε=0).
6. Atomic swap `~/.memphis/kartograf/active.onnx` symlink.
7. Audit to `system` chain `data.type='watrowanie_run'`.

## Release paths

Per roadmap trust tiers:

### Public (HF Hub + GH Release)

- HF Hub: `memphis-chains/kartograf` (Apache-2.0, public). Repo contains: ONNX FP16 + INT8 variants, tokenizer.json, envelope, model card, eval results.
- GH Release: Kartograf tarball attached to each Memphis `v1.X.0` release.

### USB / air-gap

- `memphis kartograf export --to <path>.tar.gz` packages checkpoint + envelope + SHA256 manifest.
- Target operator runs `memphis kartograf install --source file --envelope <path>/envelope.json`.
- Same verification path as online install.

### Private federation (Q3 N41)

- Station (trains) → Nomad (inference) sync via Matrix DM with envelope metadata + `mxc://` URI for binary artefact.
- Requires N14 HMAC shipped; escape-hatch is manual USB envelope.

## Y2+ roadmap (not Y1)

Deferred explicitly:
- 3 additional supervised heads (mutability / operator_facing / safety_boundary).
- Advisory generator head (bounded-length retrieval-grounded text).
- Orthogonality penalty for multi-head training.
- Cloud-grade checkpoint with larger scaffold (ModernBERT-large 395M).
- Agora marketplace `--source agora` / `--to agora` implementation.
- Cross-operator federated training (vs current peer-only-within-operator).
- Dedicated Kartograf TUI screen (Y2 post-N31 split; Y1 has only System-screen observability lines per N43).

## References

- Y1 roadmap: `docs/roadmap/Y1-2026-05-to-2027-05.md` — non-negotiables #9-12, Q2 workstreams, N-table.
- N37 corpus pipeline: `tools/training/kartograf-corpus.py` (Q1 deliverable).
- N40 checkpoint envelope: `src/kartograf/checkpoint.ts` (Q2 deliverable).
- Federation integration: `docs/dev/FEDERATION-KEY-EXCHANGE.md` (existing) + N41 (Q3).
- Superseded by this doc: `docs/dev/WATRA-BASE-DECISION.md`, `docs/dev/WATRA-EMBED-STRATEGY.md`, `docs/dev/WATRA-CORPUS-SPEC.md`, `docs/dev/WATRA-EVAL-SPEC.md`. Each gets supersede banner in this PR.
- Empirical training config: `memory/watrallm_training_empirical_2026_04_22.md`.
- Watrowanie spec: `memory/watrowanie_nightly_spec_frozen.md`.
