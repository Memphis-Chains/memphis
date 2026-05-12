/**
 * Real ONNX-backed Kartograf session — closes the Q2 deliverable
 * (spec docs/dev/KARTOGRAF-SPEC.md `Runtime (onnxruntime-node)` section).
 *
 * Loads a verified checkpoint into onnxruntime-node, attaches a tokenizer
 * via @huggingface/transformers, and serves `embed(text)` returning both
 * the 256-d embedding and the 12-class zone distribution. Factory in
 * `session.ts` gates this behind `MEMPHIS_KARTOGRAF_ENABLE=1` + an
 * installed checkpoint; otherwise consumers fall back to the stub.
 *
 * Durability notes (per operator "działa na lata" mandate 2026-05-12):
 *   - Envelope verify runs at load — broken/tampered checkpoints refuse
 *     to load rather than producing silent garbage.
 *   - ONNX bytes are re-hashed against `envelope.onnx_sha256` at load —
 *     same defense as the install handler, in case a checkpoint dir was
 *     hand-edited after install.
 *   - Zone-label count is checked against `envelope.heads_config
 *     .zone_classes` and the spec-locked `KARTOGRAF_V1_ZONE_LABELS`
 *     length. Mismatch refuses to load so we never report scores
 *     against a misaligned label set.
 *   - Session caches `model.onnx` in memory (~700 MB for full-v4
 *     DeBERTa-base). `close()` releases the native handle. Reload
 *     requires a fresh `OnnxKartografSession.load()`.
 *   - Tokenizer is loaded eagerly. transformers.js requires
 *     `tokenizer.json` + at minimum a stub `tokenizer_config.json` in
 *     the checkpoint dir. The loader auto-stamps a minimal config if
 *     none is present (matches DeBERTa-v3 defaults).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { AutoTokenizer, env as TxEnv } from '@huggingface/transformers';
import { InferenceSession, Tensor } from 'onnxruntime-node';

import { sha256Hex, verifyCheckpoint, type CheckpointEnvelope } from './checkpoint.js';
import type { KartografOutput, KartografSession, ZoneClassification } from './session.js';
import { KARTOGRAF_V1_ZONE_LABELS } from './zone-labels.js';

// Force transformers.js into local-only mode — Memphis runs offline-by-
// default and remote model downloads at runtime would violate that.
// (TxEnv mutates a shared singleton; safe because this is the only
// consumer wired into the daemon.)
TxEnv.allowLocalModels = true;
TxEnv.allowRemoteModels = false;
TxEnv.cacheDir = ''; // discourage cache lookups outside checkpoint dir

/**
 * Minimum tokenizer_config.json shape transformers.js needs to load a
 * raw tokenizer.json without trying to fetch sibling configs from HF.
 * DeBERTa-v3 specials match microsoft/deberta-v3-base; max length matches
 * the corpus build (chunks ≤ 512 tokens per spec line 137).
 */
const FALLBACK_TOKENIZER_CONFIG = {
  tokenizer_class: 'DebertaV2Tokenizer',
  model_max_length: 512,
  do_lower_case: false,
  bos_token: '[CLS]',
  eos_token: '[SEP]',
  unk_token: '[UNK]',
  sep_token: '[SEP]',
  pad_token: '[PAD]',
  cls_token: '[CLS]',
  mask_token: '[MASK]',
};

const FALLBACK_TOKENIZER_CONFIG_NAME = 'tokenizer_config.json';

export interface OnnxKartografLoadOptions {
  /** Top-K zones to return per inference (default: all zones above 0). */
  topKZones?: number;
}

export class OnnxKartografSession implements KartografSession {
  readonly checkpointId: string;
  readonly headsConfig: CheckpointEnvelope['heads_config'];
  readonly signerDid: string;
  readonly basemodel: string;

  private readonly session: InferenceSession;
  private readonly tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
  private readonly zoneLabels: readonly string[];
  private readonly topKZones: number | null;
  private closed = false;

  private constructor(args: {
    envelope: CheckpointEnvelope;
    session: InferenceSession;
    tokenizer: Awaited<ReturnType<typeof AutoTokenizer.from_pretrained>>;
    zoneLabels: readonly string[];
    topKZones: number | null;
  }) {
    this.headsConfig = args.envelope.heads_config;
    this.signerDid = args.envelope.signer_did;
    this.basemodel = args.envelope.base_model;
    this.checkpointId = args.envelope.onnx_sha256;
    this.session = args.session;
    this.tokenizer = args.tokenizer;
    this.zoneLabels = args.zoneLabels;
    this.topKZones = args.topKZones;
  }

  /**
   * Load a verified checkpoint from disk.
   *
   * `envelopePath` is the path to `checkpoint.json` under the install
   * staging dir (e.g. `~/.memphis/kartograf/checkpoints/<slug>/checkpoint.json`).
   *
   * Throws on: missing files, envelope verify failure, sha mismatch on
   * `model.onnx`, zone class count mismatch, ONNX session creation
   * failure. The thrown error carries enough detail for the operator to
   * fix without dumping internals (e.g. raw signature bytes).
   */
  static async load(
    envelopePath: string,
    options: OnnxKartografLoadOptions = {},
  ): Promise<OnnxKartografSession> {
    if (!existsSync(envelopePath)) {
      throw new Error(`kartograf: envelope not found at ${envelopePath}`);
    }
    const dir = dirname(envelopePath);
    const envelope = JSON.parse(readFileSync(envelopePath, 'utf8')) as CheckpointEnvelope;

    const verify = verifyCheckpoint(envelope);
    if (!verify.valid) {
      throw new Error(`kartograf: envelope verify failed: ${verify.reason}`);
    }

    const onnxPath = join(dir, 'model.onnx');
    if (!existsSync(onnxPath)) {
      throw new Error(`kartograf: model.onnx missing beside ${envelopePath}`);
    }
    const onnxBytes = readFileSync(onnxPath);
    const actualOnnxSha = sha256Hex(onnxBytes);
    if (actualOnnxSha !== envelope.onnx_sha256) {
      throw new Error(
        `kartograf: model.onnx sha mismatch (envelope=${envelope.onnx_sha256.slice(0, 12)}..., ` +
          `disk=${actualOnnxSha.slice(0, 12)}...). Re-install the checkpoint.`,
      );
    }

    const tokenizerPath = join(dir, 'tokenizer.json');
    if (!existsSync(tokenizerPath)) {
      throw new Error(`kartograf: tokenizer.json missing beside ${envelopePath}`);
    }

    if (envelope.heads_config.zone_classes !== KARTOGRAF_V1_ZONE_LABELS.length) {
      throw new Error(
        `kartograf: zone class count mismatch (envelope=${envelope.heads_config.zone_classes}, ` +
          `runtime labels=${KARTOGRAF_V1_ZONE_LABELS.length}). Runtime needs ` +
          `kartograf-v1 — newer checkpoints require an updated zone-labels module.`,
      );
    }

    // transformers.js wants a sibling tokenizer_config.json to set
    // special-token boundaries. Auto-stamp a minimal one (matches the
    // DeBERTa-v3 base config) so operators don't need to copy it
    // manually. The actual tokenizer.json carries the SP unigram vocab.
    const tokConfigPath = join(dir, FALLBACK_TOKENIZER_CONFIG_NAME);
    if (!existsSync(tokConfigPath)) {
      writeFileSync(tokConfigPath, JSON.stringify(FALLBACK_TOKENIZER_CONFIG, null, 2));
    }

    const session = await InferenceSession.create(onnxBytes, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      logSeverityLevel: 3, // error-only; trims tracer noise from DeBERTa export
    });

    const tokenizer = await AutoTokenizer.from_pretrained(dir);

    return new OnnxKartografSession({
      envelope,
      session,
      tokenizer,
      zoneLabels: KARTOGRAF_V1_ZONE_LABELS,
      topKZones: options.topKZones ?? null,
    });
  }

  async embed(text: string): Promise<KartografOutput> {
    if (this.closed) throw new Error('OnnxKartografSession is closed');
    // transformers.js default-returns Tensor objects with `.data`
    // (BigInt64Array for int64 inputs) and `.dims` ([batch, seq]). The
    // tokenizer truncates to max_length so the encoder never sees more
    // than its 512-token context window.
    const tokens = await this.tokenizer(text, {
      padding: false,
      truncation: true,
      max_length: 512,
    } as Parameters<typeof this.tokenizer>[1]);

    const feeds = this.encodingsToFeeds(tokens);
    const out = await this.session.run(feeds);
    return this.parseSessionOutput(out);
  }

  async embedBatch(texts: string[]): Promise<KartografOutput[]> {
    if (this.closed) throw new Error('OnnxKartografSession is closed');
    // Naive per-call batching keeps the first cut simple; we can switch
    // to packed-batch tokenize + single session.run() as a follow-up when
    // chain-side callers start hitting per-query latency walls. The
    // spec's "p95 < 25ms cold, < 8ms warm" applies to single-text;
    // batched tier-0 cascade is Q2 N21 scope (separate PR).
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.session.release();
    } catch {
      // release() can throw if ORT already torn down via process exit;
      // mark closed regardless so embed() refuses subsequent calls.
    }
  }

  private encodingsToFeeds(tokens: {
    input_ids: { data: BigInt64Array; dims: number[] };
    attention_mask: { data: BigInt64Array; dims: number[] };
  }): Record<string, Tensor> {
    // transformers.js produces Tensor objects with `.data` (BigInt64Array
    // for int64) + `.dims` ([batch, seq]). The exported ONNX graph
    // declares int64 inputs (matches training-side `dummy_ids.long()`),
    // so we forward both buffers directly into onnxruntime-node tensors.
    const ids = tokens.input_ids;
    const mask = tokens.attention_mask;
    return {
      input_ids: new Tensor('int64', ids.data, ids.dims),
      attention_mask: new Tensor('int64', mask.data, mask.dims),
    };
  }

  private parseSessionOutput(out: InferenceSession.OnnxValueMapType): KartografOutput {
    const embTensor = out.embedding;
    const zoneTensor = out.zone_logits;
    if (!embTensor || !zoneTensor) {
      throw new Error(
        `kartograf: ONNX output missing expected names (got: ${Object.keys(out).join(',')}). ` +
          `Producer must export with output_names=['embedding', 'zone_logits'].`,
      );
    }
    const embedFlat = embTensor.data as Float32Array;
    const logitsFlat = zoneTensor.data as Float32Array;

    // Output shape is [1, dim] (batch=1). Slice to a copy so the caller
    // can hold onto the buffer past the next embed() call (which reuses
    // ORT's internal pools).
    const embedding = new Float32Array(this.headsConfig.embedding_dim);
    embedding.set(embedFlat.subarray(0, this.headsConfig.embedding_dim));

    const zones = this.softmaxToZones(logitsFlat.subarray(0, this.zoneLabels.length));

    return { embedding, zones, checkpointId: this.checkpointId };
  }

  private softmaxToZones(logits: Float32Array | number[]): ZoneClassification[] {
    const arr = Array.from(logits);
    const maxLogit = Math.max(...arr);
    const exps = arr.map((v) => Math.exp(v - maxLogit));
    const sum = exps.reduce((a, b) => a + b, 0) || 1;
    const probs = exps.map((v) => v / sum);
    const ranked = probs
      .map((score, idx) => ({ zone: this.zoneLabels[idx]!, score }))
      .sort((a, b) => b.score - a.score);
    if (this.topKZones !== null && this.topKZones > 0) {
      return ranked.slice(0, this.topKZones);
    }
    return ranked;
  }
}
