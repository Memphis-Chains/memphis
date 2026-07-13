import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createRuntimeLifecycleStoppers } from '../../src/app/bootstrap.js';
import {
  __resetShutdownStateForTests,
  performGracefulShutdown,
} from '../../src/infra/runtime/graceful-shutdown.js';

describe('bootstrap runtime lifecycle stoppers', () => {
  it('stops channel, reflection, and scheduler services through graceful shutdown', async () => {
    const stopChannelGateway = vi.fn(async () => {});
    const stopReflectionLoop = vi.fn();
    const stopScheduler = vi.fn();
    const exitFn = vi.fn();

    const stopFns = createRuntimeLifecycleStoppers({
      channelGateway: { stop: stopChannelGateway },
      reflectionLoop: { stop: stopReflectionLoop },
      stopSchedulerFn: stopScheduler,
    });

    expect(stopFns.map((entry) => entry.name)).toEqual([
      'channel-gateway',
      'reflection-loop',
      'scheduler',
    ]);

    await performGracefulShutdown('SIGTERM', {
      rawEnv: { MEMPHIS_SHUTDOWN_DRAIN_TIMEOUT_MS: '50' } as NodeJS.ProcessEnv,
      auditFn: () => {},
      pulseFn: () => {},
      otelShutdownFn: async () => {},
      exitFn: exitFn as unknown as (code: number) => never,
      stopFns,
    });

    expect(stopChannelGateway).toHaveBeenCalledOnce();
    expect(stopReflectionLoop).toHaveBeenCalledOnce();
    expect(stopScheduler).toHaveBeenCalledOnce();
    expect(exitFn).toHaveBeenCalledWith(0);
    __resetShutdownStateForTests();
  });

  it('keeps the started service handles connected to the shutdown list', () => {
    const source = readFileSync(join(process.cwd(), 'src/app/bootstrap.ts'), 'utf8');

    expect(source).toContain('const channelGateway = await startChannelGateway');
    expect(source).toContain('const reflectionLoop = startReflectionLoop');
    expect(source).toContain('createRuntimeLifecycleStoppers({ channelGateway, reflectionLoop })');
  });
});
