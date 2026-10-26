import { DEFAULT_MINIMAX_MODEL } from './minimax/config.js';

export interface ProviderCapabilities {
  name: string;
  models: ModelCapabilities[];
  supportedFeatures: string[];
  rateLimits: RateLimits;
  pricing: PricingInfo;
  reliability: ReliabilityMetrics;
}

export interface ModelCapabilities {
  name: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsStreaming: boolean;
  supportsFunctionCalling: boolean;
  supportsVision: boolean;
  supportsJson: boolean;
}

export interface RateLimits {
  requestsPerMinute: number;
  tokensPerMinute: number;
}

export interface PricingInfo {
  inputCostPer1k: number;
  outputCostPer1k: number;
}

export interface ReliabilityMetrics {
  uptimePercent: number;
  avgLatency: number;
  errorRate: number;
}

export class CapabilityMatrix {
  private readonly providers = new Map<string, ProviderCapabilities>();

  constructor() {
    this.initializeProviders();
  }

  private initializeProviders(): void {
    this.providers.set('anthropic', {
      name: 'anthropic',
      models: [
        {
          name: 'claude-opus-4-6',
          contextWindow: 200000,
          maxOutputTokens: 32768,
          supportsStreaming: true,
          supportsFunctionCalling: true,
          supportsVision: true,
          supportsJson: true,
        },
        {
          name: 'claude-sonnet-4-6',
          contextWindow: 200000,
          maxOutputTokens: 16384,
          supportsStreaming: true,
          supportsFunctionCalling: true,
          supportsVision: true,
          supportsJson: true,
        },
        {
          name: 'claude-haiku-4-5-20251001',
          contextWindow: 200000,
          maxOutputTokens: 8192,
          supportsStreaming: true,
          supportsFunctionCalling: true,
          supportsVision: true,
          supportsJson: true,
        },
      ],
      supportedFeatures: ['streaming', 'function-calling', 'json-mode', 'vision'],
      rateLimits: {
        requestsPerMinute: 1000,
        tokensPerMinute: 400000,
      },
      pricing: {
        inputCostPer1k: 0.003,
        outputCostPer1k: 0.015,
      },
      reliability: {
        uptimePercent: 99.9,
        avgLatency: 600,
        errorRate: 0.001,
      },
    });

    this.providers.set('openai-compatible', {
      name: 'openai-compatible',
      models: [
        {
          name: 'gpt-4',
          contextWindow: 8192,
          maxOutputTokens: 4096,
          supportsStreaming: true,
          supportsFunctionCalling: true,
          supportsVision: false,
          supportsJson: true,
        },
        {
          name: 'gpt-4-turbo',
          contextWindow: 128000,
          maxOutputTokens: 4096,
          supportsStreaming: true,
          supportsFunctionCalling: true,
          supportsVision: true,
          supportsJson: true,
        },
      ],
      supportedFeatures: ['streaming', 'function-calling', 'json-mode'],
      rateLimits: {
        requestsPerMinute: 500,
        tokensPerMinute: 90000,
      },
      pricing: {
        inputCostPer1k: 0.03,
        outputCostPer1k: 0.06,
      },
      reliability: {
        uptimePercent: 99.9,
        avgLatency: 800,
        errorRate: 0.001,
      },
    });

    this.providers.set('ollama', {
      name: 'ollama',
      models: [
        {
          name: 'llama2',
          contextWindow: 4096,
          maxOutputTokens: 2048,
          supportsStreaming: true,
          supportsFunctionCalling: false,
          supportsVision: false,
          supportsJson: false,
        },
        {
          name: 'codellama',
          contextWindow: 16384,
          maxOutputTokens: 4096,
          supportsStreaming: true,
          supportsFunctionCalling: false,
          supportsVision: false,
          supportsJson: false,
        },
      ],
      supportedFeatures: ['streaming', 'local'],
      rateLimits: {
        requestsPerMinute: 1000,
        tokensPerMinute: 1000000,
      },
      pricing: {
        inputCostPer1k: 0,
        outputCostPer1k: 0,
      },
      reliability: {
        uptimePercent: 99.0,
        avgLatency: 200,
        errorRate: 0.01,
      },
    });

    this.providers.set('cohere', {
      name: 'cohere',
      models: [
        {
          name: 'command',
          contextWindow: 4096,
          maxOutputTokens: 2048,
          supportsStreaming: true,
          supportsFunctionCalling: false,
          supportsVision: false,
          supportsJson: true,
        },
      ],
      supportedFeatures: ['streaming', 'json-mode'],
      rateLimits: {
        requestsPerMinute: 100,
        tokensPerMinute: 100000,
      },
      pricing: {
        inputCostPer1k: 0.015,
        outputCostPer1k: 0.015,
      },
      reliability: {
        uptimePercent: 99.5,
        avgLatency: 600,
        errorRate: 0.005,
      },
    });

    // Default-model profile, verified against MiniMax's 2026-10-19 release.
    // Prices are per 1k tokens (published per-million prices divided by 1000).
    // Runtime budget caps are separate from the API's maximum output capacity.
    this.providers.set('minimax', {
      name: 'minimax',
      models: [
        {
          // 1M context, multimodal (text/image/video), tunable thinking
          // depth. Source: platform.minimax.io/docs/guides/models-intro.md
          // and /docs/api-reference/text-openai-api.md — both list
          // "MiniMax-M3.1-Flash | 1,000,000". Confirmed live 2026-10-24:
          // a 999_209-token prompt was accepted, 1_530_000 was rejected
          // with "context window exceeds limit (2013)".
          name: DEFAULT_MINIMAX_MODEL,
          contextWindow: 1000000,
          maxOutputTokens: 524288,
          supportsStreaming: true,
          supportsFunctionCalling: true,
          supportsVision: true,
          supportsJson: true,
        },
        {
          name: 'MiniMax-M3',
          contextWindow: 1000000,
          maxOutputTokens: 524288,
          supportsStreaming: true,
          supportsFunctionCalling: true,
          supportsVision: true,
          supportsJson: true,
        },
        {
          name: 'MiniMax-M2.7',
          contextWindow: 204800,
          maxOutputTokens: 32768,
          supportsStreaming: true,
          supportsFunctionCalling: true,
          // The M3 family is natively multimodal; M2.7 and the abab series
          // are text-only. Source: platform.minimax.io/docs/api-reference/text-openai-api.md
          supportsVision: false,
          supportsJson: true,
        },
        {
          name: 'abab6.5s-chat',
          contextWindow: 16384,
          maxOutputTokens: 2048,
          supportsStreaming: true,
          supportsFunctionCalling: false,
          supportsVision: false,
          supportsJson: false,
        },
      ],
      supportedFeatures: ['streaming', 'function-calling', 'json-mode', 'vision'],
      rateLimits: {
        requestsPerMinute: 60,
        tokensPerMinute: 60000,
      },
      pricing: {
        inputCostPer1k: 0.00015,
        outputCostPer1k: 0.0006,
      },
      reliability: {
        uptimePercent: 99.0,
        avgLatency: 500,
        errorRate: 0.01,
      },
    });

    this.providers.set('deepseek', {
      name: 'deepseek',
      models: [
        {
          name: 'deepseek-chat',
          contextWindow: 64000,
          maxOutputTokens: 4096,
          supportsStreaming: true,
          supportsFunctionCalling: true,
          supportsVision: false,
          supportsJson: true,
        },
      ],
      supportedFeatures: ['streaming', 'function-calling', 'json-mode'],
      rateLimits: {
        requestsPerMinute: 500,
        tokensPerMinute: 100000,
      },
      pricing: {
        inputCostPer1k: 0.0001,
        outputCostPer1k: 0.0003,
      },
      reliability: {
        uptimePercent: 99.5,
        avgLatency: 700,
        errorRate: 0.005,
      },
    });

    this.providers.set('glm', {
      name: 'glm',
      models: [
        {
          name: 'glm-4',
          contextWindow: 128000,
          maxOutputTokens: 4096,
          supportsStreaming: true,
          supportsFunctionCalling: true,
          supportsVision: false,
          supportsJson: true,
        },
        {
          name: 'glm-4-flash',
          contextWindow: 32000,
          maxOutputTokens: 2048,
          supportsStreaming: true,
          supportsFunctionCalling: true,
          supportsVision: false,
          supportsJson: true,
        },
      ],
      supportedFeatures: ['streaming', 'function-calling', 'json-mode'],
      rateLimits: {
        requestsPerMinute: 120,
        tokensPerMinute: 120000,
      },
      pricing: {
        inputCostPer1k: 0.001,
        outputCostPer1k: 0.001,
      },
      reliability: {
        uptimePercent: 99.0,
        avgLatency: 600,
        errorRate: 0.01,
      },
    });
  }

  getProvider(name: string): ProviderCapabilities | undefined {
    return this.providers.get(name);
  }

  getAllProviders(): ProviderCapabilities[] {
    return Array.from(this.providers.values());
  }

  findBestProvider(requirements: {
    minContextWindow?: number;
    needsVision?: boolean;
    needsFunctionCalling?: boolean;
    maxLatency?: number;
    maxCost?: number;
  }): ProviderCapabilities | undefined {
    const scored = this.getAllProviders().map((provider) => {
      let score = 0;

      if (requirements.minContextWindow) {
        const hasModel = provider.models.some(
          (model) => model.contextWindow >= requirements.minContextWindow!,
        );
        if (!hasModel) return { provider, score: -1 };
        score += 10;
      }

      if (requirements.needsVision) {
        const hasVision = provider.models.some((model) => model.supportsVision);
        if (!hasVision) return { provider, score: -1 };
        score += 10;
      }

      if (requirements.needsFunctionCalling) {
        const hasFunctions = provider.models.some((model) => model.supportsFunctionCalling);
        if (!hasFunctions) return { provider, score: -1 };
        score += 10;
      }

      score += provider.reliability.uptimePercent;

      if (requirements.maxLatency && provider.reliability.avgLatency <= requirements.maxLatency) {
        score += 10;
      }

      if (requirements.maxCost) {
        const avgCost = (provider.pricing.inputCostPer1k + provider.pricing.outputCostPer1k) / 2;
        if (avgCost <= requirements.maxCost) {
          score += 10;
        }
      }

      return { provider, score };
    });

    const valid = scored.filter((item) => item.score >= 0).sort((a, b) => b.score - a.score);
    return valid[0]?.provider;
  }
}
