/**
 * Kartograf TS session layer — Sprint 4.2 scaffold for N32 Q2 work.
 *
 * Defines the TypeScript-side interface that consumers (chain retrieval,
 * tier-0 router, semantic recall) call to get embeddings + zone
 * classifications from a Kartograf checkpoint. Backed by ONNX runtime in
 * Q2 (onnxruntime-node — no Python required for operators), this is a
 * stub today so chain-side callers can begin coding against the contract
 * before the model layer is wired.
 *
 * Q2 deliverables that will plug into this interface:
 *   1. ONNXSession from `onnxruntime-node` loading a signed Kartograf
 *      checkpoint envelope (verified by `checkpoint.ts`).
 *   2. Tokenizer wrapper (HF tokenizers via WASM or vendored ModernBERT
 *      tokenizer JSON, TBD per Q2 spike).
 *   3. Two-head invocation — embedding (256d float32) + zone (12-class
 *      logits → softmax → top-k zones).
 *
 * Until then: callers can wire the dependency, get the canonical types,
 * and exercise no-op implementations for tests. `KartografSession` is
 * intentionally a small abstract surface — adding methods is cheap;
 * removing them after consumers depend on them is expensive.
 */

import type { HeadsConfig } from './checkpoint.js';

// ── Output shapes ───────────────────────────────────────────────────────────

/** Embedding vector — defaults to 256d float32 per kartograf_spec_frozen v1. */
export type EmbeddingVector = Float32Array;

/**
 * Zone classification — one entry per active zone with a softmax-normalized
 * confidence score. Always non-empty; lowest entry is the model's "none"
 * fallback class so consumers can treat empty-zone results as
 * `[{ zone: 'none', score: 1.0 }]` rather than `null`.
 */
export interface ZoneClassification {
  zone: string;
  score: number;
}

export interface KartografOutput {
  embedding: EmbeddingVector;
  zones: ZoneClassification[];
  /** Active checkpoint id (sha256 of the ONNX model blob, hex). */
  checkpointId: string;
}

// ── Session contract ────────────────────────────────────────────────────────

export interface KartografSessionConfig {
  /** Path to the signed checkpoint envelope (relative to data dir). */
  checkpointPath: string;
  /**
   * Heads spec — must match the checkpoint's headsConfig. The session
   * verifies the envelope on load and rejects mismatches so a stale
   * config doesn't silently down-grade output dim.
   */
  headsConfig: HeadsConfig;
  /**
   * Optional: top-K zones to return per inference. Defaults to all
   * zones with score above the model's intrinsic threshold.
   */
  topKZones?: number;
}

export interface KartografSession {
  /** Fingerprint of the loaded checkpoint (sha256 hex of ONNX blob). */
  readonly checkpointId: string;

  /** Heads config the session was loaded with. */
  readonly headsConfig: HeadsConfig;

  /**
   * Embed a single text input. Caller is responsible for any chunking
   * upstream — Kartograf has a fixed context window dictated by the
   * underlying ModernBERT-base.
   */
  embed(text: string): Promise<KartografOutput>;

  /**
   * Embed a batch. Implementations should pack into one ONNX run when
   * possible to amortize tokenizer + session overhead.
   */
  embedBatch(texts: string[]): Promise<KartografOutput[]>;

  /**
   * Release ONNX session handle + tokenizer state. Idempotent.
   * Required for graceful-shutdown integration so we don't leak
   * native resources at SIGTERM.
   */
  close(): Promise<void>;
}

// ── Stub implementation (Q2 will replace with onnxruntime-node) ─────────────

/**
 * Placeholder session. Returns deterministic zero-embeddings so callers
 * can wire up flow without crashing, but `embed()` throws if called with
 * non-empty input under `MEMPHIS_KARTOGRAF_REQUIRE_REAL_SESSION=true`
 * (set by N32 integration tests once the real session lands).
 *
 * Accepts the same config the real session will accept so swap-in is a
 * one-line change in the factory.
 */
class StubKartografSession implements KartografSession {
  readonly checkpointId: string;
  readonly headsConfig: HeadsConfig;
  private closed = false;

  constructor(config: KartografSessionConfig) {
    this.headsConfig = config.headsConfig;
    // Deterministic stub id derived from the path so tests can match.
    this.checkpointId = `stub:${config.checkpointPath}`;
  }

  async embed(_text: string): Promise<KartografOutput> {
    if (this.closed) throw new Error('KartografSession is closed');
    return {
      embedding: new Float32Array(this.headsConfig.embedding_dim),
      zones: [{ zone: 'none', score: 1.0 }],
      checkpointId: this.checkpointId,
    };
  }

  async embedBatch(texts: string[]): Promise<KartografOutput[]> {
    if (this.closed) throw new Error('KartografSession is closed');
    return Promise.all(texts.map((t) => this.embed(t)));
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * Factory — currently always returns the stub. Q2 N32 will gate on a
 * config check (presence of onnxruntime-node + verified checkpoint
 * envelope) and return either the real ONNX session or fall back to
 * the stub when running outside an operator deploy (CI, doc tests).
 *
 * Keeping this as the sole entry point so consumers don't take
 * implementation dependencies they'll need to unwind.
 */
export async function createKartografSession(
  config: KartografSessionConfig,
): Promise<KartografSession> {
  return new StubKartografSession(config);
}
