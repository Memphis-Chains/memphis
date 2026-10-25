import { readAccountContextWindow, resolveCodexModel } from './openai-codex/client.js';

export type ModelCapabilitySnapshot = {
  contextWindowTokens: number;
  supportsStreaming: boolean;
  supportsVision: boolean;
  source: 'heuristic';
};

function openAiCompatibleCapabilities(model: string): ModelCapabilitySnapshot {
  const normalized = model.toLowerCase();

  let contextWindowTokens = 8192;
  if (
    normalized.includes('gpt-4.1') ||
    normalized.includes('gpt-4o') ||
    normalized.includes('o1') ||
    normalized.includes('glm-4')
  ) {
    contextWindowTokens = 128000;
  } else if (normalized.includes('gpt-3.5')) {
    contextWindowTokens = 16385;
  }

  const supportsVision =
    normalized.includes('vision') ||
    normalized.includes('gpt-4o') ||
    normalized.includes('omni') ||
    normalized.includes('claude-3') ||
    normalized.includes('llava') ||
    normalized.includes('glm-4v');

  return {
    contextWindowTokens,
    supportsStreaming: true,
    supportsVision,
    source: 'heuristic',
  };
}

function ollamaCapabilities(model: string): ModelCapabilitySnapshot {
  const normalized = model.toLowerCase();
  const supportsVision =
    normalized.includes('llava') ||
    normalized.includes('vision') ||
    normalized.includes('moondream');

  return {
    contextWindowTokens: 8192,
    supportsStreaming: true,
    supportsVision,
    source: 'heuristic',
  };
}

function minimaxCapabilities(model: string): ModelCapabilitySnapshot {
  // Updated 2026-07-07 to keep runtime route, CLI `models list`, and
  // provider introspection on the same source of truth. MiniMax-M3 is
  // published as a native multimodal 1M-context model; M2-family models
  // remain at 200k. The 32k fallback covers M1 + Text-01 + anything
  // else not explicitly listed.
  const normalized = model.toLowerCase();

  // M3 family, any point release and any suffix.
  //
  // 2026-10-01: this was `/^(minimax-)?m3$/i`, anchored at both ends, so
  // it only matched the bare name and the then-configured Preview alias
  // fell through to the 32k default. The GA id is now
  // `MiniMax-M3.1-Flash`; the alias remains a migration-only match. A 31x
  // understatement of the window is what makes long sessions die early,
  // and a false `supportsVision` is what makes an image get routed to a
  // text-only path.
  //
  // The 32k figure was a *fallback*, not a measurement — the window was
  // never probed. Re-measured live on 2026-10-24: a 999_209-token prompt
  // was accepted (HTTP 200) and a 1_530_000-token prompt was rejected
  // with "invalid params, context window exceeds limit (2013)". That
  // brackets the real limit at 1_000_000, matching the vendor docs
  // ("MiniMax-M3.1-Flash | 1,000,000" in
  // platform.minimax.io/docs/api-reference/text-openai-api.md).
  //
  // The family match is deliberately prefix-based rather than an
  // enumerated list: MiniMax ships point releases and preview suffixes
  // faster than this table gets updated, and every one of them inherits
  // the family's window. An unrecognised name still falls through to the
  // conservative 32k default below, so widening the pattern cannot make
  // an unknown model look capable.
  if (/^(minimax-)?m3(\.\d+)*([.-][a-z0-9]+)*$/i.test(model)) {
    return {
      contextWindowTokens: 1000000,
      supportsStreaming: true,
      supportsVision: true,
      source: 'heuristic',
    };
  }
  // abab-6.5s is the shortest-context variant in the legacy abab
  // family (per old docs); keep the explicit override.
  if (normalized.includes('abab6.5s')) {
    return {
      contextWindowTokens: 16384,
      supportsStreaming: true,
      supportsVision: false,
      source: 'heuristic',
    };
  }
  // M2 family (M2, M2.1, M2.5, M2.7 + their -highspeed variants) and
  // m2-her: 200k input window. Regex matches both the `MiniMax-M2`
  // capitalization Memphis sends and the docs' lowercase form.
  // M2 family: `M2`, `M2.1`, `M2.5`, `M2.7`, their `-highspeed` variants,
  // and `m2-her`. Point releases and suffixes are matched by prefix, same
  // reasoning as the M3 branch above.
  if (/^(minimax-)?m2(\.\d+)*([.-][a-z0-9]+)*$/i.test(model)) {
    return {
      contextWindowTokens: 200000,
      supportsStreaming: true,
      supportsVision: false,
      source: 'heuristic',
    };
  }
  // M1 + Text-01 + the remaining legacy chat surfaces: 32k.
  return {
    contextWindowTokens: 32000,
    supportsStreaming: true,
    supportsVision: false,
    source: 'heuristic',
  };
}

function deepseekCapabilities(model: string): ModelCapabilitySnapshot {
  const normalized = model.toLowerCase();
  return {
    contextWindowTokens: normalized.includes('reasoner') ? 128000 : 64000,
    supportsStreaming: true,
    supportsVision: false,
    source: 'heuristic',
  };
}

function anthropicCapabilities(model: string): ModelCapabilitySnapshot {
  const normalized = model.toLowerCase();
  const isOpus = normalized.includes('opus');
  return {
    contextWindowTokens: isOpus ? 200000 : 200000,
    supportsStreaming: true,
    supportsVision: true,
    source: 'heuristic',
  };
}

function openAiCodexCapabilities(
  model: string,
  rawEnv: NodeJS.ProcessEnv,
): ModelCapabilitySnapshot | undefined {
  const resolved = resolveCodexModel(model).model;
  if (!['gpt-6-astra', 'gpt-5.6-sol'].includes(resolved)) {
    return undefined;
  }
  // Both supported families document a 1,050,000-token ceiling. The account
  // is usually granted less, and the Codex catalog on disk records that grant,
  // so the effective limit is the smaller value. Reading it here means the
  // FIRST request of a conversation is already trimmed to the real ceiling.
  const declared = 1_050_000;
  const account = readAccountContextWindow(rawEnv, resolved);
  return {
    contextWindowTokens: account === undefined ? declared : Math.min(declared, account),
    supportsStreaming: true,
    // This adapter currently forwards text and Memphis tool calls.
    supportsVision: false,
    source: 'heuristic',
  };
}

export function resolveModelCapabilitySnapshot(
  provider: string,
  model: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): ModelCapabilitySnapshot | undefined {
  if (!provider.trim() || !model.trim()) return undefined;

  switch (provider) {
    case 'openai':
      return openAiCodexCapabilities(model, rawEnv);
    case 'anthropic':
      return anthropicCapabilities(model);
    case 'local-fallback':
      return {
        contextWindowTokens: 2048,
        supportsStreaming: false,
        supportsVision: false,
        source: 'heuristic',
      };
    case 'ollama':
      return ollamaCapabilities(model);
    case 'minimax':
      return minimaxCapabilities(model);
    case 'deepseek':
      return deepseekCapabilities(model);
    case 'shared-llm':
    case 'decentralized-llm':
    case 'glm':
      return openAiCompatibleCapabilities(model);
    default:
      return undefined;
  }
}
