import { describe, expect, it } from 'vitest';
import { createLogger } from '../../src/infra/logging/logger.js';

describe('createLogger', () => {
  it('emits JSON logs with required fields', () => {
    const lines: string[] = [];
    const logger = createLogger('info', 'json', {}, (line) => lines.push(line));

    logger.info({ method: 'GET', path: '/health', status: 200, duration_ms: 5 }, 'Request completed');

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as {
      timestamp: string;
      level: string;
      message: string;
      context: Record<string, unknown>;
    };

    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('Request completed');
    expect(parsed.context).toEqual({ method: 'GET', path: '/health', status: 200, duration_ms: 5 });
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('respects log level filtering', () => {
    const lines: string[] = [];
    const logger = createLogger('info', 'text', {}, (line) => lines.push(line));

    logger.debug('debug hidden');
    logger.info('info shown');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[INFO] info shown');
  });

  it('formats text logs with context and child bindings', () => {
    const lines: string[] = [];
    const logger = createLogger('debug', 'text', { service: 'memphis-v4' }, (line) => lines.push(line));
    const child = logger.child({ reqId: 'abc-123' });

    child.info({ method: 'GET', status: 200 }, 'Request completed');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.* \[INFO\] Request completed /);
    expect(lines[0]).toContain('service=memphis-v4');
    expect(lines[0]).toContain('reqId=abc-123');
    expect(lines[0]).toContain('method=GET');
    expect(lines[0]).toContain('status=200');
  });
});
