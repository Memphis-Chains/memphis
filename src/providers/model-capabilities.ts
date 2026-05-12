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
  // Updated 2026-05-12 to match the current MiniMax model lineup
  // (https://platform.minimax.io/docs/guides/models-intro). All M2
  // family models advertise the 200k-input / 128k-output window from
  // M2's published spec; we pin to 200k here because that's the
  // larger of the two and request-side truncation is what the runtime
  // needs to guard against. The 32k fallback covers M1 + Text-01 +
  // anything else not explicitly listed.
  const normalized = model.toLowerCase();
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
  if (/^(minimax-)?m2(\.\d+)?(-highspeed)?$|^m2-her$/i.test(model)) {
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

export function resolveModelCapabilitySnapshot(
  provider: string,
  model: string,
): ModelCapabilitySnapshot | undefined {
  if (!provider.trim() || !model.trim()) return undefined;

  switch (provider) {
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
