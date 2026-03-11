import { existsSync } from 'node:fs';

import { createAppContainer } from './container.js';
import { AppError, errorTemplates } from '../core/errors.js';
import { checkOllama, checkRustToolchain } from '../infra/cli/utils/dependencies.js';
import { loadConfig } from '../infra/config/env.js';
import { createHttpServer } from '../infra/http/server.js';
import { writeSecurityAudit } from '../infra/logging/security-audit.js';
import { verifyChainIntegrity } from '../infra/storage/chain-adapter.js';

export async function bootstrap(): Promise<void> {
  if (!existsSync('.env')) {
    throw errorTemplates.missingEnv();
  }

  const rust = checkRustToolchain();
  if (!rust.ok) {
    throw new AppError('CONFIG_ERROR', rust.detail, 500, rust.meta, rust.fix);
  }

  const config = loadConfig();
  if (config.RUST_EMBED_MODE === 'ollama') {
    const ollama = await checkOllama({ rawEnv: process.env });
    if (!ollama.ok) {
      throw errorTemplates.missingOllama({
        url: String(ollama.meta?.url ?? 'http://127.0.0.1:11434'),
        required: true,
        details: ollama.meta,
      });
    }
  }

  try {
    await verifyChainIntegrity();
    writeSecurityAudit({
      action: 'chain.verify.startup',
      status: 'allowed',
      details: { message: 'chain verification passed' },
    });
  } catch (error) {
    writeSecurityAudit({
      action: 'chain.verify.startup',
      status: 'error',
      details: { message: error instanceof Error ? error.message : 'chain verification failed' },
    });
    throw new AppError(
      'VALIDATION_ERROR',
      `chain integrity verification failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      500,
    );
  }

  const container = createAppContainer(config);
  const app = createHttpServer(config, container.orchestration, {
    sessionRepository: container.sessionRepository,
    generationEventRepository: container.generationEventRepository,
  });

  await app.listen({ host: config.HOST, port: config.PORT });
}
