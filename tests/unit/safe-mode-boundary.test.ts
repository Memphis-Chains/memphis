import { afterEach, describe, expect, it } from 'vitest';

import { exec } from '../../src/agent/system.js';
import { AppError } from '../../src/core/errors.js';
import { OrchestrationService } from '../../src/modules/orchestration/service.js';
import { LocalFallbackProvider } from '../../src/providers/local-fallback/adapter.js';

describe('safe mode boundaries', () => {
  const originalSafeMode = process.env.MEMPHIS_SAFE_MODE;

  afterEach(() => {
    if (originalSafeMode === undefined) delete process.env.MEMPHIS_SAFE_MODE;
    else process.env.MEMPHIS_SAFE_MODE = originalSafeMode;
  });

  it('blocks system command execution at kernel boundary', () => {
    process.env.MEMPHIS_SAFE_MODE = 'true';
    const out = exec('echo hello');
    expect(out.exitCode).toBe(-1);
    expect(out.stderr).toContain('FORBIDDEN_IN_SAFE_MODE');
  });

  it('blocks orchestration generate flow while in safe mode', async () => {
    process.env.MEMPHIS_SAFE_MODE = 'true';
    const service = new OrchestrationService({
      defaultProvider: 'local-fallback',
      providers: [new LocalFallbackProvider()],
    });

    await expect(
      service.generate({
        input: 'hello',
        provider: 'auto',
      }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
