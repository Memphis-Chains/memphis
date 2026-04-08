import { describe, expect, it, vi } from 'vitest';

import {
  checkDependencies,
  checkNodeVersion,
  checkOllama,
  checkRustToolchain,
} from '../../src/infra/cli/utils/dependencies.js';

describe('dependency checks', () => {
  it('validates supported node versions', () => {
    expect(checkNodeVersion('v22.1.0').ok).toBe(true);
    expect(checkNodeVersion('v20.19.0').ok).toBe(false);
  });

  it('reports rust toolchain details', () => {
    const result = checkRustToolchain((command) => {
      if (command === 'cargo') return 'cargo 1.80.0';
      return 'rustc 1.80.0';
    });

    expect(result.ok).toBe(true);
    expect(result.detail).toContain('cargo 1.80.0');
  });

  it('fails ollama when required and binary is missing and the API is unreachable', async () => {
    const result = await checkOllama({
      rawEnv: { RUST_EMBED_MODE: 'ollama' },
      commandRunner: () => {
        throw new Error('missing');
      },
      fetchImpl: vi.fn(),
    });

    expect(result.ok).toBe(false);
    expect(result.required).toBe(true);
    expect(result.level).toBe('fail');
    expect(result.fix).toContain('ollama');
  });

  it('warns when ollama API is reachable but the CLI binary is missing', async () => {
    const result = await checkOllama({
      rawEnv: { RUST_EMBED_MODE: 'ollama' },
      commandRunner: () => {
        throw new Error('missing');
      },
      fetchImpl: vi.fn().mockResolvedValue({ ok: true }),
    });

    expect(result.ok).toBe(true);
    expect(result.required).toBe(true);
    expect(result.level).toBe('warn');
    expect(result.detail).toContain('/api/tags');
    expect(result.detail).toContain('not on PATH');
  });

  it('aggregates dependency checks', async () => {
    const checks = await checkDependencies({
      rawEnv: { RUST_EMBED_MODE: 'local' },
      commandRunner: (command) => {
        if (command === 'cargo') return 'cargo 1.80.0';
        if (command === 'rustc') return 'rustc 1.80.0';
        if (command === 'ollama') return 'ollama version 0.5.7';
        return '';
      },
      fetchImpl: vi.fn().mockResolvedValue({ ok: true }),
    });

    expect(checks.map((check) => check.id)).toEqual(['node-version', 'rust-toolchain', 'ollama']);
  });
});
