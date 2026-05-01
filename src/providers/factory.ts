import { OllamaProvider } from './index.js';
import type { ChatMessage } from './index.js';

export interface ResolvedProvider {
  provider: {
    chat: (
      messages: Array<{ role: string; content: string }>,
      options?: { model?: string; temperature?: number; max_tokens?: number },
    ) => Promise<{ content?: string }>;
  };
  model: string;
}

/**
 * Resolve a lightweight provider for fast classification calls (used by
 * cognitive/categorizer.ts LLM fallback). Returns null when the provider
 * is unconfigured or unavailable; caller falls back to pattern-only
 * suggestions.
 *
 * S5-6 (Level A plan): the prior implementation returned `null`
 * unconditionally, so categorizer's `enableLLMFallback: true` was
 * silent dead code — the three-tier model cascade (qwen2.5:0.5b →
 * phi3 → default) all collapsed to "no suggestions" with no
 * operator-visible signal. This adapter wires the real OllamaProvider
 * so the feature actually works when an operator opts in.
 *
 * Scope is intentionally narrow: ollama-only (the only provider any
 * current caller asks for). Non-ollama hints are rejected explicitly.
 */
export async function resolveProvider(opts?: {
  provider?: 'ollama';
  model?: string;
  skipOpenClaw?: boolean;
}): Promise<ResolvedProvider | null> {
  if (opts?.provider && opts.provider !== 'ollama') {
    return null;
  }
  const provider = new OllamaProvider(opts?.model ? { model: opts.model } : undefined);
  if (!provider.isConfigured()) {
    return null;
  }
  if (!(await provider.isAvailable())) {
    return null;
  }
  // Codex P1 round 1: when a specific model is requested, verify Ollama
  // has it installed before returning. Without this, an Ollama instance
  // running but missing `qwen2.5:0.5b` would still resolve as
  // "available", so the categorizer's three-tier cascade
  // (qwen2.5:0.5b → phi3 → default) collapsed to the first tier and
  // the chat call later threw — caller swallows it and emits zero
  // suggestions even when a fallback model would have worked.
  //
  // Match accepts the canonical Ollama tag form ("phi3:latest") for a
  // bare-model hint ("phi3") so operators don't have to spell the tag.
  if (opts?.model) {
    const installed = await provider.listModels();
    const wanted = opts.model;
    const wantedBase = wanted.split(':')[0];
    const matched = installed.some((name) => name === wanted || name.split(':')[0] === wantedBase);
    if (!matched) {
      return null;
    }
  }
  return {
    provider: {
      chat: async (messages, options) => {
        const response = await provider.chat(messages as ChatMessage[], {
          model: options?.model,
          temperature: options?.temperature,
          maxTokens: options?.max_tokens,
        });
        return { content: response.content };
      },
    },
    model: opts?.model ?? provider.defaultModel(),
  };
}
