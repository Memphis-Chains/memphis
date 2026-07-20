import { createProvider, defaultProviderConfig } from '../../providers/index.js';
import {
  resolveModelCapabilitySnapshot,
  type ModelCapabilitySnapshot,
} from '../../providers/model-capabilities.js';

export interface ProviderStatus {
  name: string;
  type: string;
  priority: number;
  configured: boolean;
  defaultModel: string;
  defaultModelCapability: ModelCapabilitySnapshot | null;
  models: string[];
  modelCapabilities: Record<string, ModelCapabilitySnapshot>;
}

export interface ProvidersOutput {
  count: number;
  providers: ProviderStatus[];
}

export async function runMemphisProviders(): Promise<ProvidersOutput> {
  const config = defaultProviderConfig();
  const providers: ProviderStatus[] = await Promise.all(
    config.providers.map(async (cfg) => {
      const provider = createProvider(cfg);
      let models: string[] = [];
      try {
        models = await provider.listModels();
      } catch {
        // Provider may be unreachable
      }
      return {
        name: cfg.name,
        type: cfg.type,
        priority: cfg.priority,
        configured: provider.isConfigured(),
        defaultModel: provider.defaultModel(),
        defaultModelCapability:
          resolveModelCapabilitySnapshot(cfg.name, provider.defaultModel()) ?? null,
        models,
        modelCapabilities: Object.fromEntries(
          models
            .map((model) => [model, resolveModelCapabilitySnapshot(cfg.name, model)] as const)
            .filter((entry): entry is readonly [string, ModelCapabilitySnapshot] =>
              Boolean(entry[1]),
            ),
        ),
      };
    }),
  );

  return {
    count: providers.length,
    providers,
  };
}
