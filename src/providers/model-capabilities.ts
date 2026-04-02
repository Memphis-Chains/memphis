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
  const normalized = model.toLowerCase();
  return {
    contextWindowTokens: normalized.includes('abab6.5s') ? 16384 : 32000,
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

export function resolveModelCapabilitySnapshot(
  provider: string,
  model: string,
): ModelCapabilitySnapshot | undefined {
  if (!provider.trim() || !model.trim()) return undefined;

  switch (provider) {
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
