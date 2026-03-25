import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import prompts from 'prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runConfigureWizard } from '../src/infra/cli/commands/configure.js';

const ctx = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => ctx.home };
});

vi.mock('prompts', () => ({
  default: vi.fn(),
}));

describe('configure wizard', () => {
  beforeEach(() => {
    ctx.home = mkdtempSync(join(tmpdir(), 'memphis-test-'));
    vi.restoreAllMocks();
  });

  afterEach(() => {
    rmSync(ctx.home, { recursive: true, force: true });
  });

  it('supports non-interactive dry-run', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    const result = await runConfigureWizard({ nonInteractive: true, dryRun: true, noVault: true });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.configPath.endsWith('/.memphis/config.yaml')).toBe(true);
    expect(result.provider).toBe('local-fallback');
  });

  it('runs interactive flow with mocked prompts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    const promptMock = vi.mocked(prompts);
    promptMock
      .mockResolvedValueOnce({ stateDir: '~/.memphis-test' })
      .mockResolvedValueOnce({ enabled: true })
      .mockResolvedValueOnce({ value: 'StrongPass!2026' })
      .mockResolvedValueOnce({ value: 'StrongPass!2026' })
      .mockResolvedValueOnce({ value: "What is your pet's name?" })
      .mockResolvedValueOnce({ value: 'Fluffy' })
      .mockResolvedValueOnce({ value: 'ollama' })
      .mockResolvedValueOnce({ value: true })
      .mockResolvedValueOnce({ value: 'nomic-embed-text' });

    const result = await runConfigureWizard({ dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.provider).toBe('ollama');
    expect(result.stateDir.endsWith('/.memphis-test')).toBe(true);
    expect(promptMock).toHaveBeenCalled();
  });
});
