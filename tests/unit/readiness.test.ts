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

import { getTelegramReadinessStatus } from '../../src/gateway/channels/telegram-readiness.js';
import { buildReadinessReport } from '../../src/infra/cli/commands/readiness.js';
import { getChainAdapterStatus } from '../../src/infra/storage/chain-adapter.js';
import { getRustEmbedAdapterStatus } from '../../src/infra/storage/rust-embed-adapter.js';
import { inspectFirstRunStatus } from '../../src/onboarding/first-run.js';
import { probeVaultCipherCycle } from '../../src/security/vault-boundary.js';

const mockedTelegram = vi.mocked(getTelegramReadinessStatus);
const mockedFirstRun = vi.mocked(inspectFirstRunStatus);
const mockedVault = vi.mocked(probeVaultCipherCycle);
const mockedChain = vi.mocked(getChainAdapterStatus);
const mockedEmbed = vi.mocked(getRustEmbedAdapterStatus);

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
