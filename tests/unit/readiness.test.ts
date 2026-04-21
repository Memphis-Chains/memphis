import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/gateway/channels/telegram-readiness.js', () => ({
  getTelegramReadinessStatus: vi.fn(),
}));
vi.mock('../../src/onboarding/first-run.js', () => ({
  inspectFirstRunStatus: vi.fn(),
}));
vi.mock('../../src/security/vault-boundary.js', () => ({
  probeVaultCipherCycle: vi.fn(),
}));
vi.mock('../../src/infra/storage/chain-adapter.js', () => ({
  getChainAdapterStatus: vi.fn(),
}));
vi.mock('../../src/infra/storage/rust-embed-adapter.js', () => ({
  getRustEmbedAdapterStatus: vi.fn(),
}));
vi.mock('../../src/providers/index.js', () => ({
  resolveProviderKeyResult: vi.fn(),
}));
vi.mock('../../src/infra/config/vault-resolve.js', () => ({
  resolveVaultSecret: vi.fn(),
}));

import { getTelegramReadinessStatus } from '../../src/gateway/channels/telegram-readiness.js';
import { buildReadinessReport } from '../../src/infra/cli/commands/readiness.js';
import { resolveVaultSecret } from '../../src/infra/config/vault-resolve.js';
import { getChainAdapterStatus } from '../../src/infra/storage/chain-adapter.js';
import { getRustEmbedAdapterStatus } from '../../src/infra/storage/rust-embed-adapter.js';
import { inspectFirstRunStatus } from '../../src/onboarding/first-run.js';
import { resolveProviderKeyResult } from '../../src/providers/index.js';
import { probeVaultCipherCycle } from '../../src/security/vault-boundary.js';

const mockedTelegram = vi.mocked(getTelegramReadinessStatus);
const mockedFirstRun = vi.mocked(inspectFirstRunStatus);
const mockedVault = vi.mocked(probeVaultCipherCycle);
const mockedChain = vi.mocked(getChainAdapterStatus);
const mockedEmbed = vi.mocked(getRustEmbedAdapterStatus);
const mockedProvider = vi.mocked(resolveProviderKeyResult);
const mockedResolveVaultSecret = vi.mocked(resolveVaultSecret);

function allHealthy(): void {
  mockedFirstRun.mockReturnValue({
    state: 'initialized-clean',
    initialized: true,
    envPresent: true,
    vaultInitialized: true,
    operatorConfigured: true,
    legacyChains: [],
    legacyFiles: 0,
    reasons: [],
    recommendedAction: 'none',
    record: {
      schemaVersion: 1,
      initializedAt: '2026-04-20T20:00:00.000Z',
      mode: 'minimal-baseline',
      createdChains: ['journal'],
      createdBlocks: 1,
      summary: 'ok',
      origin: 'controlled-init',
    },
  } as ReturnType<typeof inspectFirstRunStatus>);
  mockedVault.mockReturnValue({ ok: true });
  mockedChain.mockReturnValue({ rustBridgeLoaded: true } as ReturnType<typeof getChainAdapterStatus>);
  mockedEmbed.mockReturnValue({
    embedApiAvailable: true,
  } as ReturnType<typeof getRustEmbedAdapterStatus>);
  mockedTelegram.mockResolvedValue({
    state: 'ready',
    configured: false,
    gatewayEnabled: false,
    allowlistEnabled: false,
    allowlistCount: 0,
  } as unknown as Awaited<ReturnType<typeof getTelegramReadinessStatus>>);
  mockedProvider.mockReturnValue({ source: 'vault', key: 'secret-redacted' });
  // Default: pass through untouched (plaintext) or resolve VAULT: to a fixed value.
  mockedResolveVaultSecret.mockImplementation((value: string | undefined) => {
    if (!value) return undefined;
    if (value.startsWith('VAULT:')) return 'SUPER-SECRET-PLAINTEXT';
    return value;
  });
}

let scratch = '';

beforeEach(() => {
  vi.clearAllMocks();
  scratch = mkdtempSync(join(tmpdir(), 'memphis-readiness-'));
  writeFileSync(join(scratch, '.env'), 'DEFAULT_PROVIDER=local-fallback\n');
});

describe('buildReadinessReport', () => {
  it('returns ok=true when every critical row is OK', async () => {
    allHealthy();
    const report = await buildReadinessReport({
      env: {
        MEMPHIS_ENV_FILE: join(scratch, '.env'),
        DEFAULT_PROVIDER: 'local-fallback',
      },
    });
    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.rows.find((r) => r.id === 'env_file')?.level).toBe('ok');
    expect(report.rows.find((r) => r.id === 'loop_limits')?.detail).toContain('max_tool_calls=64');
  });

  it('exits 1 when a critical row fails', async () => {
    allHealthy();
    mockedVault.mockReturnValue({ ok: false, error: 'vault locked' });
    const report = await buildReadinessReport({
      env: { MEMPHIS_ENV_FILE: join(scratch, '.env') },
    });
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(report.rows.find((r) => r.id === 'vault')?.level).toBe('fail');
  });

  it('exits 2 when only non-critical rows warn', async () => {
    allHealthy();
    mockedChain.mockReturnValue({ rustBridgeLoaded: false } as ReturnType<
      typeof getChainAdapterStatus
    >);
    const report = await buildReadinessReport({
      env: {
        MEMPHIS_ENV_FILE: join(scratch, '.env'),
        DEFAULT_PROVIDER: 'local-fallback',
      },
    });
    expect(report.exitCode).toBe(2);
    expect(report.rows.find((r) => r.id === 'rust_bridge')?.level).toBe('warn');
  });

  it('reports env_file fail when the path does not exist', async () => {
    allHealthy();
    const report = await buildReadinessReport({
      env: {
        MEMPHIS_ENV_FILE: join(scratch, 'does-not-exist.env'),
        DEFAULT_PROVIDER: 'local-fallback',
      },
    });
    expect(report.rows.find((r) => r.id === 'env_file')?.level).toBe('fail');
    expect(report.exitCode).toBe(1);
  });

  it('surfaces telegram gateway warnings when token is present but gateway is off', async () => {
    allHealthy();
    mockedTelegram.mockResolvedValue({
      state: 'degraded',
      configured: true,
      gatewayEnabled: false,
      allowlistEnabled: true,
      allowlistCount: 2,
    } as unknown as Awaited<ReturnType<typeof getTelegramReadinessStatus>>);
    const report = await buildReadinessReport({
      env: {
        MEMPHIS_ENV_FILE: join(scratch, '.env'),
        DEFAULT_PROVIDER: 'local-fallback',
      },
    });
    const tg = report.rows.find((r) => r.id === 'telegram');
    expect(tg?.level).toBe('warn');
    expect(tg?.detail).toContain('MEMPHIS_CHANNEL_GATEWAY_ENABLED');
  });

  // sanity: the tmpdir shim actually exists for the happy-path test
  it('scratch fixture is present for the suite', () => {
    expect(existsSync(join(scratch, '.env'))).toBe(true);
  });
});

describe('checkDefaultProvider covers every DEFAULT_PROVIDER value', () => {
  beforeEach(() => allHealthy());

  it('ollama reports info (no key required) instead of warn', async () => {
    const report = await buildReadinessReport({
      env: {
        MEMPHIS_ENV_FILE: join(scratch, '.env'),
        DEFAULT_PROVIDER: 'ollama',
        OLLAMA_URL: 'http://127.0.0.1:11434',
      },
    });
    const prov = report.rows.find((r) => r.id === 'default_provider');
    expect(prov?.level).toBe('info');
    expect(prov?.detail).toContain('ollama');
    // Regression guard: previously this fell into the generic "no
    // *_VAULT_KEY" warn branch and pushed exit code to 2.
    expect(report.exitCode).not.toBe(1);
  });

  it('shared-llm fails loud when API_BASE is missing', async () => {
    const report = await buildReadinessReport({
      env: {
        MEMPHIS_ENV_FILE: join(scratch, '.env'),
        DEFAULT_PROVIDER: 'shared-llm',
        SHARED_LLM_API_KEY: 'sk-x',
      },
    });
    const prov = report.rows.find((r) => r.id === 'default_provider');
    expect(prov?.level).toBe('fail');
    expect(prov?.detail).toContain('SHARED_LLM_API_BASE');
  });

  it('shared-llm passes with both base + key set', async () => {
    const report = await buildReadinessReport({
      env: {
        MEMPHIS_ENV_FILE: join(scratch, '.env'),
        DEFAULT_PROVIDER: 'shared-llm',
        SHARED_LLM_API_BASE: 'https://llm.example.com',
        SHARED_LLM_API_KEY: 'sk-x',
      },
    });
    expect(report.rows.find((r) => r.id === 'default_provider')?.level).toBe('ok');
  });

  it('shared-llm passes when API_KEY is a valid VAULT ref (vault entry found)', async () => {
    // Default mock treats VAULT:... as resolving to 'vault-resolved' — this
    // is the happy path. The operator's .env has `SHARED_LLM_API_KEY=VAULT:<name>`
    // (the on-disk form written by `memphis vault add`), and the vault
    // entry actually exists. Readiness must not false-flag this as fail.
    const report = await buildReadinessReport({
      env: {
        MEMPHIS_ENV_FILE: join(scratch, '.env'),
        DEFAULT_PROVIDER: 'shared-llm',
        SHARED_LLM_API_BASE: 'https://llm.example.com',
        SHARED_LLM_API_KEY: 'VAULT:shared_llm_api_key',
      },
    });
    const prov = report.rows.find((r) => r.id === 'default_provider');
    expect(prov?.level).toBe('ok');
    // Leakage guard (Codex P2): detail must NOT contain the resolved
    // plaintext. `SHARED_LLM_API_KEY` is typically sensitive; the URL
    // could carry embedded credentials too. Surface only env var names.
    expect(prov?.detail).not.toContain('SUPER-SECRET-PLAINTEXT');
    expect(prov?.detail).toContain('SHARED_LLM_API_KEY (vault-resolved)');
  });

  it('shared-llm fails when API_KEY vault entry cannot be resolved', async () => {
    mockedResolveVaultSecret.mockImplementation((value: string | undefined) => {
      if (!value) return undefined;
      if (value === 'VAULT:missing_key') return undefined; // vault miss
      if (value.startsWith('VAULT:')) return 'SUPER-SECRET-PLAINTEXT';
      return value;
    });
    const report = await buildReadinessReport({
      env: {
        MEMPHIS_ENV_FILE: join(scratch, '.env'),
        DEFAULT_PROVIDER: 'shared-llm',
        SHARED_LLM_API_BASE: 'https://llm.example.com',
        SHARED_LLM_API_KEY: 'VAULT:missing_key',
      },
    });
    const prov = report.rows.find((r) => r.id === 'default_provider');
    expect(prov?.level).toBe('fail');
    expect(prov?.detail).toContain('vault entry that does not exist');
  });

  it('decentralized-llm fails when API_BASE vault entry cannot be resolved', async () => {
    mockedResolveVaultSecret.mockImplementation((value: string | undefined) => {
      if (!value) return undefined;
      if (value === 'VAULT:dec_llm_base') return undefined;
      if (value.startsWith('VAULT:')) return 'SUPER-SECRET-PLAINTEXT';
      return value;
    });
    const report = await buildReadinessReport({
      env: {
        MEMPHIS_ENV_FILE: join(scratch, '.env'),
        DEFAULT_PROVIDER: 'decentralized-llm',
        DECENTRALIZED_LLM_API_BASE: 'VAULT:dec_llm_base',
        DECENTRALIZED_LLM_API_KEY: 'sk-x',
      },
    });
    const prov = report.rows.find((r) => r.id === 'default_provider');
    expect(prov?.level).toBe('fail');
    expect(prov?.detail).toContain('DECENTRALIZED_LLM_API_BASE');
  });

  it('anthropic vault_not_found fails loud (instead of fake-ok from env-only check)', async () => {
    mockedProvider.mockReturnValue({
      source: 'none',
      reason: 'vault_not_found',
    });
    const report = await buildReadinessReport({
      env: {
        MEMPHIS_ENV_FILE: join(scratch, '.env'),
        DEFAULT_PROVIDER: 'anthropic',
        ANTHROPIC_VAULT_KEY: 'anthropic_api_key',
      },
    });
    const prov = report.rows.find((r) => r.id === 'default_provider');
    expect(prov?.level).toBe('fail');
    expect(prov?.detail).toContain('vault entry is missing');
    expect(report.exitCode).toBe(1);
  });

  it('anthropic vault_error fails with a doctor hint', async () => {
    mockedProvider.mockReturnValue({ source: 'none', reason: 'vault_error' });
    const report = await buildReadinessReport({
      env: {
        MEMPHIS_ENV_FILE: join(scratch, '.env'),
        DEFAULT_PROVIDER: 'anthropic',
        ANTHROPIC_VAULT_KEY: 'anthropic_api_key',
      },
    });
    const prov = report.rows.find((r) => r.id === 'default_provider');
    expect(prov?.level).toBe('fail');
    expect(prov?.detail).toMatch(/vault lookup errored/);
  });

  it('plaintext source warns and suggests moving to vault', async () => {
    mockedProvider.mockReturnValue({ source: 'plaintext', key: 'sk-plaintext' });
    const report = await buildReadinessReport({
      env: {
        MEMPHIS_ENV_FILE: join(scratch, '.env'),
        DEFAULT_PROVIDER: 'minimax',
        MINIMAX_API_KEY: 'sk-plaintext',
      },
    });
    const prov = report.rows.find((r) => r.id === 'default_provider');
    expect(prov?.level).toBe('warn');
    expect(prov?.detail).toMatch(/consider moving to vault/);
  });

  it('conflict source fails with the vault error surfaced', async () => {
    mockedProvider.mockReturnValue({
      source: 'conflict',
      vaultError: "entry 'anthropic_api_key' not found in vault",
      plaintextKey: 'sk-x',
    });
    const report = await buildReadinessReport({
      env: {
        MEMPHIS_ENV_FILE: join(scratch, '.env'),
        DEFAULT_PROVIDER: 'anthropic',
        ANTHROPIC_VAULT_KEY: 'anthropic_api_key',
        ANTHROPIC_API_KEY: 'sk-x',
      },
    });
    const prov = report.rows.find((r) => r.id === 'default_provider');
    expect(prov?.level).toBe('fail');
    expect(prov?.detail).toContain('not found in vault');
  });
});
