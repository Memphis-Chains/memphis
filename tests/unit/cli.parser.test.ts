import { describe, expect, it } from 'vitest';

import { parseCommand } from '../../src/infra/cli/parser.js';

describe('CLI parser', () => {
  it('parses telegram/provider management flags from the main parser', () => {
    const parsed = parseCommand([
      'node',
      'memphis',
      'setup',
      'telegram',
      '--api-key',
      'provider-key',
      '--bot-token',
      'telegram-token',
      '--allowed-user-ids',
      '1,2,3',
    ]);

    expect(parsed.command).toBe('setup');
    expect(parsed.subcommand).toBe('telegram');
    expect(parsed.apiKey).toBe('provider-key');
    expect(parsed.botToken).toBe('telegram-token');
    expect(parsed.allowedUserIds).toBe('1,2,3');
  });

  it('keeps existing runtime and strategy flags intact', () => {
    const parsed = parseCommand([
      'node',
      'memphis',
      'schedule',
      'run',
      '--id',
      'job-1',
      '--runtime',
      '--strategy',
      'latency-aware',
      '--json',
    ]);

    expect(parsed.command).toBe('schedule');
    expect(parsed.subcommand).toBe('run');
    expect(parsed.id).toBe('job-1');
    expect(parsed.runtime).toBe(true);
    expect(parsed.strategy).toBe('latency-aware');
    expect(parsed.json).toBe(true);
  });
});
