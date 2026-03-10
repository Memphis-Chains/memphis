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
        const hasModel = provider.models.some((model) => model.contextWindow >= requirements.minContextWindow!);
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
