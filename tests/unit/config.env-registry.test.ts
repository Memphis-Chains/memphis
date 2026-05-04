/**
 * Sprint D Phase 1 — env-registry foundation tests.
 *
 * Pin the accessor semantics: env-wins, default-fallback, trim, secret
 * preview hygiene, and the registry-report shape that doctor renders.
 */
import { describe, expect, it } from 'vitest';

import {
  buildEnvRegistryReport,
  ENV_REGISTRY,
  HOME,
  LOG_LEVEL,
  MEMPHIS_AGENT_NAME,
  MEMPHIS_OWNER_NAME,
  NODE_ENV,
} from '../../src/config/env-registry.js';

describe('env-registry — typed accessors', () => {
  it('LOG_LEVEL: env wins over default', () => {
    expect(LOG_LEVEL.read({ LOG_LEVEL: 'debug' } as NodeJS.ProcessEnv)).toBe('debug');
    expect(LOG_LEVEL.read({} as NodeJS.ProcessEnv)).toBe('info');
  });

  it('LOG_LEVEL: invalid env value falls through to default', () => {
    // Enum accessor rejects unknown values rather than passing them through —
    // mirrors the Zod enum behaviour at config load time.
    expect(LOG_LEVEL.read({ LOG_LEVEL: 'silly' } as NodeJS.ProcessEnv)).toBe('info');
  });

  it('NODE_ENV: env wins, default is development', () => {
    expect(NODE_ENV.read({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toBe('production');
    expect(NODE_ENV.read({} as NodeJS.ProcessEnv)).toBe('development');
  });

  it('MEMPHIS_AGENT_NAME / MEMPHIS_OWNER_NAME: trim + default', () => {
    expect(
      MEMPHIS_AGENT_NAME.read({ MEMPHIS_AGENT_NAME: '  Jawor  ' } as NodeJS.ProcessEnv),
    ).toBe('Jawor');
    expect(MEMPHIS_AGENT_NAME.read({} as NodeJS.ProcessEnv)).toBe('Memphis Agent');
    expect(MEMPHIS_OWNER_NAME.read({ MEMPHIS_OWNER_NAME: 'Marcin' } as NodeJS.ProcessEnv)).toBe(
      'Marcin',
    );
    expect(MEMPHIS_OWNER_NAME.read({} as NodeJS.ProcessEnv)).toBe('local operator');
  });

  it('empty / whitespace-only env is treated as absent', () => {
    expect(MEMPHIS_AGENT_NAME.read({ MEMPHIS_AGENT_NAME: '' } as NodeJS.ProcessEnv)).toBe(
      'Memphis Agent',
    );
    expect(MEMPHIS_AGENT_NAME.read({ MEMPHIS_AGENT_NAME: '   ' } as NodeJS.ProcessEnv)).toBe(
      'Memphis Agent',
    );
  });

  it('HOME: env wins, default falls back to os.homedir() snapshot', () => {
    expect(HOME.read({ HOME: '/srv/op' } as NodeJS.ProcessEnv)).toBe('/srv/op');
    // The default is captured from os.homedir() at module load — assert it's
    // a non-empty absolute-ish path string. Don't pin the exact value.
    expect(HOME.defaultValue.length).toBeGreaterThan(0);
  });
});

describe('env-registry — inspection contract', () => {
  it('inspect() reports source=env when set', () => {
    expect(LOG_LEVEL.inspect({ LOG_LEVEL: 'warn' } as NodeJS.ProcessEnv)).toEqual({
      source: 'env',
      preview: 'warn',
      isSecret: false,
    });
  });

  it('inspect() reports source=default when unset', () => {
    expect(LOG_LEVEL.inspect({} as NodeJS.ProcessEnv)).toEqual({
      source: 'default',
      preview: 'info',
      isSecret: false,
    });
  });

  it('inspect() truncates long string previews to 64 chars', () => {
    const longName = 'A'.repeat(120);
    const inspection = MEMPHIS_AGENT_NAME.inspect({
      MEMPHIS_AGENT_NAME: longName,
    } as NodeJS.ProcessEnv);
    expect(inspection.preview.length).toBeLessThanOrEqual(64);
    expect(inspection.preview.endsWith('…')).toBe(true);
  });
});

describe('env-registry — registry surface', () => {
  it('ENV_REGISTRY exposes every defined accessor', () => {
    const names = ENV_REGISTRY.map((acc) => acc.name);
    expect(names).toContain('LOG_LEVEL');
    expect(names).toContain('NODE_ENV');
    expect(names).toContain('MEMPHIS_AGENT_NAME');
    expect(names).toContain('MEMPHIS_OWNER_NAME');
    expect(names).toContain('HOME');
  });

  it('buildEnvRegistryReport returns count + entries snapshot', () => {
    const report = buildEnvRegistryReport({
      LOG_LEVEL: 'debug',
      NODE_ENV: 'production',
    } as NodeJS.ProcessEnv);
    expect(report.count).toBe(ENV_REGISTRY.length);
    const logEntry = report.entries.find((e) => e.name === 'LOG_LEVEL');
    expect(logEntry).toEqual({
      name: 'LOG_LEVEL',
      description: expect.stringContaining('pino'),
      source: 'env',
      preview: 'debug',
      isSecret: false,
    });
    const nodeEntry = report.entries.find((e) => e.name === 'NODE_ENV');
    expect(nodeEntry?.source).toBe('env');
    expect(nodeEntry?.preview).toBe('production');
  });

  it('report distinguishes env-set from default for each accessor', () => {
    const report = buildEnvRegistryReport({} as NodeJS.ProcessEnv);
    for (const entry of report.entries) {
      expect(entry.source).toBe('default');
    }
  });
});
