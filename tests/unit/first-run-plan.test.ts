import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { inspectFirstRunStatusReport } from '../../src/onboarding/first-run.js';

describe('first-run status report', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('exposes guided and minimal previews for a clean not-initialized runtime', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'memphis-first-run-plan-'));
    const envPath = join(runtimeDir, '.env');
    writeFileSync(envPath, 'DEFAULT_PROVIDER=local-fallback\n', 'utf8');

    process.env = {
      ...originalEnv,
      MEMPHIS_DATA_DIR: join(runtimeDir, '.memphis'),
      MEMPHIS_ENV_FILE: envPath,
    };

    const report = inspectFirstRunStatusReport(process.env);
    expect(report.state).toBe('not-initialized');
    expect(report.plan.canInitialize).toBe(true);
    expect(report.plan.suggestedMode).toBe('guided-conversation');
    expect(report.plan.preview?.minimalBaseline.createdBlocks).toBe(2);
    expect(report.plan.preview?.guidedConversation.createdBlocks).toBe(4);
    expect(report.plan.preview?.guidedConversation.prompts).toContain('primary purpose');
  });

  it('forces repair instead of init when legacy state is detected', () => {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'memphis-first-run-plan-legacy-'));
    const envPath = join(runtimeDir, '.env');
    writeFileSync(envPath, 'DEFAULT_PROVIDER=local-fallback\n', 'utf8');
    const chainDir = join(runtimeDir, '.memphis', 'chains', 'journal');
    mkdirSync(chainDir, { recursive: true });
    writeFileSync(
      join(chainDir, '000001.json'),
      JSON.stringify(
        {
          index: 1,
          timestamp: new Date('2026-04-01T12:00:00.000Z').toISOString(),
          chain: 'journal',
          data: { message: 'legacy block shape' },
          prev_hash: '0'.repeat(64),
          hash: '1'.repeat(64),
        },
        null,
        2,
      ),
      'utf8',
    );

    process.env = {
      ...originalEnv,
      MEMPHIS_DATA_DIR: join(runtimeDir, '.memphis'),
      MEMPHIS_ENV_FILE: envPath,
    };

    const report = inspectFirstRunStatusReport(process.env);
    expect(report.state).toBe('legacy-migrateable');
    expect(report.plan.requiresRepair).toBe(true);
    expect(report.plan.nextCommand).toBe('memphis repair runtime');
    expect(report.plan.preview).toBeNull();
  });
});
