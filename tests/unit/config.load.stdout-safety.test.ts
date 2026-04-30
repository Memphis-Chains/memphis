import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unmock('../../src/infra/config/vault-resolve.js');
});

describe('loadConfig stdout safety', () => {
  it('writes vault resolution notices to stderr without polluting stdout', async () => {
    vi.mock('../../src/infra/config/vault-resolve.js', () => ({
      resolveVaultSecrets: vi.fn((rawEnv: NodeJS.ProcessEnv) => {
        rawEnv.MEMPHIS_API_TOKEN = 'resolved-api-token';
        return { resolved: ['MEMPHIS_API_TOKEN'], failed: [] };
      }),
    }));

    const stdoutWrites: string[] = [];
    const stderrWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdoutWrites.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stderrWrites.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    const { loadConfig } = await import('../../src/infra/config/env.js');

    const cfg = loadConfig({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: '3000',
      LOG_LEVEL: 'debug',
      DEFAULT_PROVIDER: 'local-fallback',
      LOCAL_FALLBACK_ENABLED: 'true',
      GEN_TIMEOUT_MS: '30000',
      GEN_MAX_TOKENS: '512',
      GEN_TEMPERATURE: '0.4',
      RUST_CHAIN_ENABLED: 'false',
      RUST_CHAIN_BRIDGE_PATH: './crates/memphis-napi',
      DATABASE_URL: 'file:./data/test.db',
      MEMPHIS_API_TOKEN: 'VAULT:api-token',
    });

    expect(cfg.MEMPHIS_API_TOKEN).toBe('resolved-api-token');
    expect(stdoutWrites.join('')).not.toContain('[memphis-config] Resolved');
    expect(stderrWrites.join('')).toContain('[memphis-config] Resolved 1 secret(s) from vault');
  });
});
