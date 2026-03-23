import { describe, expect, it } from 'vitest';

import { createLogger } from '../../src/infra/logging/logger.js';

describe('logger — HTTP object serialization', () => {
  it('serializes Fastify-like request objects instead of [unserializable]', () => {
    const lines: string[] = [];
    const logger = createLogger('info', 'text', {}, (line) => lines.push(line));

    logger.info({
      req: { method: 'GET', url: '/health', hostname: 'localhost', remoteAddress: '127.0.0.1' },
    }, 'request received');

    expect(lines[0]).toContain('method=GET');
    expect(lines[0]).toContain('url=/health');
    expect(lines[0]).not.toContain('[unserializable]');
  });

  it('serializes Fastify-like response objects', () => {
    const lines: string[] = [];
    const logger = createLogger('info', 'text', {}, (line) => lines.push(line));

    logger.info({ res: { statusCode: 200 } }, 'response sent');

    expect(lines[0]).toContain('statusCode=200');
    expect(lines[0]).not.toContain('[unserializable]');
  });

  it('still falls back to [unserializable] for truly circular objects', () => {
    const lines: string[] = [];
    const logger = createLogger('info', 'text', {}, (line) => lines.push(line));

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    logger.info({ obj: circular }, 'circular');

    expect(lines[0]).toContain('[unserializable]');
  });

  it('serializes regular objects as JSON', () => {
    const lines: string[] = [];
    const logger = createLogger('info', 'text', {}, (line) => lines.push(line));

    logger.info({ data: { key: 'value' } }, 'data log');

    expect(lines[0]).toContain('"key":"value"');
  });

  it('respects log level filtering', () => {
    const lines: string[] = [];
    const logger = createLogger('warn', 'text', {}, (line) => lines.push(line));

    logger.info('should not appear');
    logger.warn('should appear');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('should appear');
  });

  it('child logger inherits bindings', () => {
    const lines: string[] = [];
    const logger = createLogger('info', 'text', {}, (line) => lines.push(line));
    const child = logger.child({ reqId: '123' });

    child.info('test');

    expect(lines[0]).toContain('reqId=123');
  });

  it('JSON format produces valid JSON lines', () => {
    const lines: string[] = [];
    const logger = createLogger('info', 'json', {}, (line) => lines.push(line));

    logger.info('test message');

    const parsed = JSON.parse(lines[0]!);
    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('test message');
    expect(parsed.timestamp).toBeDefined();
  });
});
