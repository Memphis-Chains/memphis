import type { FastifyInstance } from 'fastify';

import type {
  GenerationEventRepository,
  SessionRepository,
} from '../../../core/contracts/repository.js';
import type { AppConfig } from '../../config/schema.js';
import { getChainAdapterStatus } from '../../storage/chain-adapter.js';
import { getRustEmbedAdapterStatus } from '../../storage/rust-embed-adapter.js';
import { getRustVaultAdapterStatus } from '../../storage/rust-vault-adapter.js';

export function registerCognitiveSessionRoutes(
  app: FastifyInstance,
  config: AppConfig,
  repos?: {
    sessionRepository: SessionRepository;
    generationEventRepository: GenerationEventRepository;
  },
): void {
  // ── Cognitive & System Status (for TUI) ─────────────────────────
  app.get('/v1/cognitive/status', async () => {
    const { getCognitiveMode, getCognitiveModeLastModified } =
      await import('../../../soul/manifest.js');
    const { getCognitiveModeConfig } = await import('../../../cognitive/modes.js');
    const { resolveMaxTokensForStyle } = await import('../../../cognitive/mode-dispatch.js');
    const { loadPulseEntries } = await import('../../runtime/heartbeat-watchdog.js');
    const { resolveProviderKeyResult } = await import('../../../providers/index.js');

    const mode = getCognitiveMode(process.env);
    const modeConfig = getCognitiveModeConfig(mode);
    const lastModified = getCognitiveModeLastModified();
    const pulseEntries = loadPulseEntries();
    const lastPulse = pulseEntries.at(-1);
    const chainStatus = getChainAdapterStatus(process.env);
    const vaultStatus = getRustVaultAdapterStatus(process.env);
    const embedStatus = getRustEmbedAdapterStatus(process.env);

    const providerKeys = ['minimax', 'deepseek', 'glm'].map((name) => {
      const result = resolveProviderKeyResult(name);
      return { name, source: result.source };
    });

    return {
      cognitiveMode: {
        active: mode,
        config: {
          name: modeConfig.name,
          description: modeConfig.description,
          temperature: modeConfig.temperature,
          style: modeConfig.style,
          pattern: modeConfig.pattern,
          maxTokens: resolveMaxTokensForStyle(modeConfig.style, process.env),
        },
        lastModified,
      },
      availableModes: ['A', 'B', 'C', 'D', 'E'],
      pulse: lastPulse
        ? {
            health: lastPulse.health,
            timestamp: lastPulse.timestamp,
            uptimeSeconds: lastPulse.uptimeSeconds,
          }
        : { health: 'unknown', timestamp: null, uptimeSeconds: 0 },
      defaultProvider: config.DEFAULT_PROVIDER,
      providerKeys,
      adapters: {
        chain: { backend: chainStatus.backend, loaded: chainStatus.rustBridgeLoaded },
        vault: { loaded: vaultStatus.bridgeLoaded, available: vaultStatus.vaultApiAvailable },
        embed: { loaded: embedStatus.bridgeLoaded, available: embedStatus.embedApiAvailable },
      },
      tiers: {
        description: 'Tier 0: no auth, Tier 1: API token, Tier 2: vault passphrase',
        currentTier: config.MEMPHIS_API_TOKEN ? 1 : 0,
      },
    };
  });

  app.get('/v1/sessions', async () => {
    if (!repos) return { sessions: [] };
    const sessions = repos.sessionRepository.listSessions();
    return { sessions };
  });

  app.get<{ Params: { sessionId: string } }>('/v1/sessions/:sessionId/events', async (request) => {
    if (!repos) {
      return { sessionId: request.params.sessionId, events: [] };
    }

    const sessionId = request.params.sessionId;
    const events = repos.generationEventRepository.listBySession(sessionId);
    return { sessionId, events };
  });
}
