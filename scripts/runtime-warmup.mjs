#!/usr/bin/env node
// Runtime warmup v3 — pre-load local models into Ollama with auto-fallback
// from GPU to CPU on runner crash (signal during cgo execution).
//
// Fixes: offline.ready = false (during cold-load windows) which blocks
// canSelfRecover → canSelfModify gates in self-governance.
//
// Models to warm (read from .env OLLAMA_MODEL + RUST_EMBED_MODE):
//   - ollama LLM model (OLLAMA_MODEL, default qwen2.5-coder:3b)
//   - embedding model (nomic-embed-text, default for RUST_EMBED_MODE=ollama)
//
// Defensive strategy:
//   1. Probe Ollama (cheap /api/tags)
//   2. GPU tune num_ctx based on available VRAM
//   3. Warm LLM with GPU offload (default)
//   4. On runner crash (HTTP 500 with "signal during cgo execution"):
//      - Retry with num_gpu=0 (CPU only) at smaller ctx
//      - Log warning so operator knows GPU is broken
//   5. Per-model retry with backoff. Best-effort: exits 0 even on partial fail.
//
// Usage:
//   node scripts/runtime-warmup.mjs           # warm both models (default)
//   node scripts/runtime-warmup.mjs --llm-only
//   node scripts/runtime-warmup.mjs --embed-only
//   node scripts/runtime-warmup.mjs --skip-gpu-tune   # use existing OLLAMA_NUM_CTX
//   node scripts/runtime-warmup.mjs --cpu-only        # force CPU (skip GPU attempt)

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const LLM_MODEL_DEFAULT = 'qwen2.5-coder:3b';
const EMBED_MODEL = 'nomic-embed-text'; // hardcoded for RUST_EMBED_MODE=ollama
const SAFETY_VRAM_MB = 256; // reserve for Xorg + compose
const TIMEOUT_MS = 60_000;
const RUNNER_CRASH_REGEX = /signal arrived during cgo execution/i;

const args = new Set(process.argv.slice(2));
const llmOnly = args.has('--llm-only');
const embedOnly = args.has('--embed-only');
const skipGpuTune = args.has('--skip-gpu-tune');
const cpuOnly = args.has('--cpu-only');

function loadDotenv() {
  const path = '/home/memphis/memphis/.env';
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, k, v] = m;
    if (!process.env[k]) process.env[k] = v;
  }
}
loadDotenv();

function getVramMb() {
  try {
    const out = execFileSync(
      'nvidia-smi',
      ['--query-gpu=memory.total,memory.free', '--format=csv,noheader,nounits'],
      { encoding: 'utf8', timeout: 5000 },
    );
    const lines = out.trim().split('\n');
    if (lines.length === 0) return null;
    const [total, free] = lines[0].split(',').map((s) => Number(s.trim()));
    if (!Number.isFinite(total) || !Number.isFinite(free)) return null;
    return { total: Math.round(total), free: Math.round(free) };
  } catch {
    return null;
  }
}

async function probeOllama() {
  const t0 = Date.now();
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    return { ok: r.ok, ms: Date.now() - t0, status: r.status };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: e.message };
  }
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function warmOne(stage, model, body) {
  const t0 = Date.now();
  try {
    const r = await fetchWithTimeout(`${OLLAMA_URL}/api/${stage}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, TIMEOUT_MS);
    const dt = Date.now() - t0;
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      return { ok: false, ms: dt, status: r.status, err: errText.slice(0, 200) };
    }
    return { ok: true, ms: dt };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: e.message };
  }
}

function pickNumctx(vram, modelSizeMb) {
  if (!vram) return 2048;
  const usable = vram.free - SAFETY_VRAM_MB - modelSizeMb;
  if (usable <= 0) return 512;
  if (usable < 200) return 1024;
  if (usable < 600) return 2048;
  if (usable < 1200) return 4096;
  return 8192;
}

async function probeModelSize(model) {
  try {
    const r = await fetch(`${OLLAMA_URL}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return Math.round((j.size ?? 0) / (1024 * 1024));
  } catch {
    return null;
  }
}

async function warmLLM(model, numCtx, allowGpu) {
  // Phase 1: try GPU (default) unless cpu-only flag
  if (allowGpu) {
    const gpuBody = {
      model,
      prompt: 'respond with the word READY',
      stream: false,
      options: { num_ctx: numCtx, num_predict: 8, num_gpu: 99 },
    };
    const gpuResult = await warmOne('generate', model, gpuBody);
    if (gpuResult.ok) return { ok: true, mode: 'gpu', ms: gpuResult.ms };
    console.error(JSON.stringify({ stage: 'warm_llm', model, mode: 'gpu', ok: false, ms: gpuResult.ms, err: gpuResult.err }));
    if (!RUNNER_CRASH_REGEX.test(gpuResult.err ?? '')) {
      // Non-runner-crash failure: don't auto-fallback, just return
      return { ok: false, mode: 'gpu', err: gpuResult.err };
    }
    console.error(JSON.stringify({ stage: 'gpu_runner_crash_detected', fallback: 'cpu', model }));
  }

  // Phase 2: CPU fallback (smaller ctx to avoid OOM in RAM)
  const cpuNumCtx = Math.min(numCtx, 2048);
  const cpuBody = {
    model,
    prompt: 'respond with the word READY',
    stream: false,
    options: { num_ctx: cpuNumCtx, num_predict: 8, num_gpu: 0 },
  };
  const cpuResult = await warmOne('generate', model, cpuBody);
  if (cpuResult.ok) {
    console.log(JSON.stringify({ stage: 'warm_llm', model, mode: 'cpu_fallback', ok: true, ms: cpuResult.ms, num_ctx: cpuNumCtx }));
    return { ok: true, mode: 'cpu_fallback', ms: cpuResult.ms };
  }
  console.error(JSON.stringify({ stage: 'warm_llm', model, mode: 'cpu_fallback', ok: false, ms: cpuResult.ms, err: cpuResult.err }));
  return { ok: false, mode: 'cpu_fallback', err: cpuResult.err };
}

async function main() {
  const p = await probeOllama();
  if (!p.ok) {
    console.error(JSON.stringify({ stage: 'probe', ok: false, ms: p.ms, err: p.err ?? `status=${p.status}` }));
    console.error('Ollama unreachable — skipping warmup (memphis will operate in cold-load mode)');
    process.exit(0);
  }
  console.log(JSON.stringify({ stage: 'probe', ok: true, ollama_url: OLLAMA_URL, ms: p.ms }));

  let llmOk = true;
  let llmMode = null;
  let embedOk = true;

  if (!embedOnly) {
    const llmModel = process.env.OLLAMA_MODEL ?? LLM_MODEL_DEFAULT;
    let numCtx = Number(process.env.OLLAMA_NUM_CTX) || 2048;

    if (!skipGpuTune) {
      const vram = getVramMb();
      const modelSize = await probeModelSize(llmModel);
      const tuned = pickNumctx(vram, modelSize ?? 1900);
      console.log(JSON.stringify({
        stage: 'gpu_tune',
        gpu_vram_total_mb: vram?.total,
        gpu_vram_free_mb: vram?.free,
        model_size_mb: modelSize,
        recommended_num_ctx: tuned,
        env_num_ctx: numCtx,
        using: tuned,
      }));
      numCtx = tuned;
    }

    const llmResult = await warmLLM(llmModel, numCtx, !cpuOnly);
    llmOk = llmResult.ok;
    llmMode = llmResult.mode;
  }

  if (!llmOnly) {
    const embedResult = await warmOne('embeddings', EMBED_MODEL, {
      model: EMBED_MODEL,
      prompt: 'warmup',
    });
    if (embedResult.ok) {
      console.log(JSON.stringify({ stage: 'warm_embed', model: EMBED_MODEL, ok: true, ms: embedResult.ms }));
    } else {
      console.error(JSON.stringify({ stage: 'warm_embed', model: EMBED_MODEL, ok: false, ms: embedResult.ms, err: embedResult.err }));
    }
    embedOk = embedResult.ok;
  }

  console.log(JSON.stringify({
    ok: llmOk && embedOk,
    llm_ok: llmOk,
    llm_mode: llmMode,
    embed_ok: embedOk,
    ollama_url: OLLAMA_URL,
    note: llmMode === 'cpu_fallback' ? 'GPU runner crashes detected, model loaded on CPU. Investigate ollama/llama.cpp GPU compatibility.' : undefined,
  }, null, 2));
  process.exit(0);
}

main();
