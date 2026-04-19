/**
 * Small Model Support (≤3b parameters)
 *
 * Models like cogito:3b, phi, gemma, qwen2.5, llama3.2 require different
 * temperature and token configurations than larger models.
 */

export interface GenerationConfig {
  temperature: number;
  maxTokens: number;
  topP?: number;
  topK?: number;
}

export const COGITO_3B_CONFIG: GenerationConfig = {
  temperature: 0.3,
  maxTokens: 2048,
  topP: 0.9,
  topK: 40,
};

/**
 * Returns true if the model name indicates a small model (≤3b parameters).
 */
export function isSmallModel(modelName: string): boolean {
  const name = modelName.toLowerCase();
  return (
    /:3b$/.test(name) ||
    /\b3b\b/.test(name) ||
    /phi/.test(name) ||
    /gemma/.test(name) ||
    /qwen2\.5/.test(name) ||
    /llama3\.2/.test(name) ||
    /codellama/.test(name) ||
    (/mistral/.test(name) && !/7b/.test(name)) ||
    /granite/.test(name)
  );
}

/**
 * Returns the provider configuration optimized for small models.
 * These models benefit from lower temperature and shorter max tokens
 * due to their smaller context window and reduced reasoning capacity.
 */
export function getSmallModelConfig(_model: string): GenerationConfig {
  return {
    temperature: 0.3,
    maxTokens: 2048,
    topP: 0.9,
    topK: 40,
  };
}

/**
 * Returns the provider configuration optimized for large models (>3b).
 */
export function getLargeModelConfig(_model: string): GenerationConfig {
  return {
    temperature: 0.7,
    maxTokens: 8192,
    topP: 0.95,
    topK: 80,
  };
}

/**
 * Determines if a model should use conservative (low-risk) generation settings.
 * Small models and coding-focused models benefit from this.
 */
export function isConservativeModel(modelName: string): boolean {
  const name = modelName.toLowerCase();
  return (
    isSmallModel(name) || /codellama/.test(name) || /starcoder/.test(name) || /codeqwen/.test(name)
  );
}
