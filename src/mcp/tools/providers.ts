import { createProvider, defaultProviderConfig } from '../../providers/index.js';

export interface ProviderStatus {
  name: string;
  type: string;
  priority: number;
  configured: boolean;
  defaultModel: string;
  models: string[];
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
        models,
      };
    }),
  );

  return {
    count: providers.length,
    providers,
  };
}
