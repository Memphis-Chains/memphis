import prompts from 'prompts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runConfigureWizard } from '../src/infra/cli/commands/configure.js';

vi.mock('prompts', () => ({
  default: vi.fn(),
}));

describe('configure wizard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('supports non-interactive dry-run', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    const result = await runConfigureWizard({ nonInteractive: true, dryRun: true });
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
