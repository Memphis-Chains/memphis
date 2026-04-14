import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runPostApplyHooks } from '../../src/infra/config/post-apply-hooks.js';
import {
  __resetAppLoggerRegistryForTests,
  createLogger,
  setAllAppLoggerLevels,
} from '../../src/infra/logging/logger.js';
import {
  __resetPinoRegistryForTests,
  createPinoLogger,
  setAllPinoLoggerLevels,
} from '../../src/infra/logging/pino.js';

// Side-effect import: registers the LOG_LEVEL post-apply hook.
import '../../src/infra/logging/contextual.js';

describe('LOG_LEVEL hot-swap (Sprint deferral closed)', () => {
  beforeEach(() => {
    __resetPinoRegistryForTests();
    __resetAppLoggerRegistryForTests();
  });

  afterEach(() => {
    __resetPinoRegistryForTests();
    __resetAppLoggerRegistryForTests();
  });

  it('AppLogger.setLevel mutates the live threshold without rebuilding', () => {
    const captured: string[] = [];
    const logger = createLogger('info', 'text', {}, (line) => {
      captured.push(line);
    });

    logger.debug('first debug — below info threshold, should drop');
    expect(captured).toHaveLength(0);

    logger.setLevel('debug');
    logger.debug('second debug — now at debug threshold, should land');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toContain('second debug');
  });

  it('setAllAppLoggerLevels walks the registry', () => {
    const captured1: string[] = [];
    const captured2: string[] = [];
    const a = createLogger('warn', 'text', {}, (line) => captured1.push(line));
    const b = createLogger('warn', 'text', {}, (line) => captured2.push(line));

    a.info('drop a');
    b.info('drop b');
    expect(captured1).toHaveLength(0);
    expect(captured2).toHaveLength(0);

    const result = setAllAppLoggerLevels('debug');
    expect(result.updated).toBeGreaterThanOrEqual(2);

    a.info('keep a');
    b.info('keep b');
    expect(captured1).toHaveLength(1);
    expect(captured2).toHaveLength(1);
  });

  it('setAllPinoLoggerLevels mutates each live pino instance', () => {
    const a = createPinoLogger({ level: 'warn' });
    const b = createPinoLogger({ level: 'warn' });
    expect(a.level).toBe('warn');
    expect(b.level).toBe('warn');

    const result = setAllPinoLoggerLevels('debug');
    expect(result.updated).toBeGreaterThanOrEqual(2);
    expect(a.level).toBe('debug');
    expect(b.level).toBe('debug');
  });

  it('post-apply hook for LOG_LEVEL flips both registries', async () => {
    const captured: string[] = [];
    const appLogger = createLogger('error', 'text', {}, (line) => captured.push(line));
    const pinoLogger = createPinoLogger({ level: 'error' });

    await runPostApplyHooks({
      changes: [{ key: 'LOG_LEVEL', oldValue: 'error', newValue: 'debug' }],
    });

    expect(appLogger.level).toBe('debug');
    expect(pinoLogger.level).toBe('debug');

    appLogger.info('should land at info now');
    expect(captured.some((line) => line.includes('should land at info now'))).toBe(true);
  });

  it('post-apply hook coerces unknown level back to info default', async () => {
    const appLogger = createLogger('debug', 'text', {}, () => {});
    await runPostApplyHooks({
      changes: [{ key: 'LOG_LEVEL', oldValue: 'debug', newValue: 'NOT_A_LEVEL' }],
    });
    expect(appLogger.level).toBe('info');
  });

  it('post-apply hook reverts to default (info) when LOG_LEVEL unset', async () => {
    const appLogger = createLogger('debug', 'text', {}, () => {});
    await runPostApplyHooks({
      changes: [{ key: 'LOG_LEVEL', oldValue: 'debug', newValue: undefined }],
    });
    expect(appLogger.level).toBe('info');
  });
});
