/**
 * The resource observations are ADDITIVE to the governance verdict.
 *
 * `memphis_self_governance_status` publishes `resources` next to
 * `capable` / `canSelfRecover` / `canSelfModify`. The contract is that the
 * observations never move that verdict: they are a reading of the host, not
 * an input to the gate.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Measured 2026-11-09: the whole governance suite was green while the tool
 * could drop `resources` from its output completely, and nothing noticed.
 * The mutation "return snapshot" instead of "return { ...snapshot,
 * resources }" passed every gate in the repository.
 *
 * The second half of this file is the stronger claim, and the one a reader
 * of the tool would assume without checking: an observation that says "the
 * host is fine" must not be able to unblock self-modification, and an
 * observation that says "the host is broken" must not be able to block it
 * either. Both directions are asserted here.
 *
 * The verdict itself is stubbed so the two directions can be tested in
 * isolation. With the real builder, `canSelfModify` is false in this
 * fixture because the SLO windows are empty — which means an "observations
 * block self-modification" mutation is invisible: `false && false` is the
 * same `false` as the unmodified `false`. The stub puts the verdict in a
 * known state, so the observations are the only variable.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const observeResources = vi.hoisted(() => vi.fn());
const buildSelfGovernanceSnapshot = vi.hoisted(() => vi.fn());

vi.mock('../../src/infra/runtime/resource-observation.js', () => ({
  observeResources,
}));

vi.mock('../../src/infra/runtime/self-governance.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/infra/runtime/self-governance.js')>();
  return { ...actual, buildSelfGovernanceSnapshot };
});

import { runMemphisSelfGovernanceStatus } from '../../src/mcp/tools/self-governance-status.js';

const UNOBSERVABLE = {
  startedAt: '2026-11-09T00:00:00.000Z',
  observedAt: '2026-11-09T00:00:00.000Z',
  purpose: 'instantaneous-observation' as const,
  scope: 'host-observation-not-cgroup-limit' as const,
  cpu: { status: 'unavailable' as const, source: 'os.cpus', reason: 'not measured' },
  memory: { status: 'unavailable' as const, source: '/proc/meminfo', reason: 'not measured' },
  dataFilesystem: {
    status: 'unavailable' as const,
    source: 'statfs(data directory)',
    reason: 'not measured',
  },
  pressure: {
    cpu: { status: 'unavailable' as const, source: '/proc/pressure/cpu', reason: 'not measured' },
    memory: {
      status: 'unavailable' as const,
      source: '/proc/pressure/memory',
      reason: 'not measured',
    },
    io: { status: 'unavailable' as const, source: '/proc/pressure/io', reason: 'not measured' },
  },
  gpu: { status: 'unavailable' as const, source: 'nvidia-smi', reason: 'not measured' },
};

const HEALTHY_HOST = {
  ...UNOBSERVABLE,
  cpu: {
    status: 'observed' as const,
    source: 'os.cpus',
    value: { utilizationPercent: 5, sampleMs: 250, logicalCpus: 4 },
  },
  memory: {
    status: 'observed' as const,
    source: '/proc/meminfo',
    value: { totalBytes: 16_000_000_000, availableBytes: 12_000_000_000 },
  },
  dataFilesystem: {
    status: 'observed' as const,
    source: 'statfs(data directory)',
    value: { totalBytes: 240_000_000_000, availableBytes: 100_000_000_000 },
  },
};

function snapshotWith(canSelfModify: boolean) {
  return {
    mode: 'supervised-operational' as const,
    capable: true,
    canSelfRecover: true,
    canSelfModify,
    blockingReasons: canSelfModify ? [] : ['SLO unavailable (1h): p99_turn_latency_ms'],
    recommendedActions: canSelfModify ? [] : ['Run memphis slo status --json'],
    freshness: { generatedAt: '2026-11-09T00:00:00.000Z' },
  };
}

let env: NodeJS.ProcessEnv;

beforeEach(() => {
  observeResources.mockReset();
  observeResources.mockResolvedValue(UNOBSERVABLE);
  buildSelfGovernanceSnapshot.mockReset();
  buildSelfGovernanceSnapshot.mockReturnValue(snapshotWith(false));
  const dir = mkdtempSync(join(tmpdir(), 'memphis-governance-resources-'));
  const other = mkdtempSync(join(tmpdir(), 'memphis-governance-resources-other-'));
  mkdirSync(join(other, 'backups'));
  writeFileSync(join(other, 'backups', 'other-runtime.tar.gz'), 'synthetic');
  env = {
    ...process.env,
    HOME: dir,
    MEMPHIS_DATA_DIR: dir,
    MEMPHIS_ENV_FILE: join(dir, 'missing-env'),
    DEFAULT_PROVIDER: 'local-fallback',
    LOCAL_FALLBACK_ENABLED: 'true',
    RUST_CHAIN_ENABLED: 'false',
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('self-governance status — resource observations', () => {
  it('publishes the observations next to the governance verdict', async () => {
    const snapshot = await runMemphisSelfGovernanceStatus(env);
    expect(snapshot.resources).toEqual(UNOBSERVABLE);
    expect(observeResources).toHaveBeenCalledTimes(1);
  });

  it('does not let a healthy host unblock self-modification', async () => {
    buildSelfGovernanceSnapshot.mockReturnValue(snapshotWith(false));
    observeResources.mockResolvedValue(HEALTHY_HOST);
    const snapshot = await runMemphisSelfGovernanceStatus(env);
    expect(snapshot.resources).toEqual(HEALTHY_HOST);
    // The verdict came from the governance builder. A healthy host reading
    // must not remove a blocker the builder reported.
    expect(snapshot.canSelfModify).toBe(false);
    expect(snapshot.blockingReasons).toEqual(['SLO unavailable (1h): p99_turn_latency_ms']);
  });

  it('does not let a broken host block self-modification either', async () => {
    buildSelfGovernanceSnapshot.mockReturnValue(snapshotWith(true));
    observeResources.mockResolvedValue(UNOBSERVABLE);
    const snapshot = await runMemphisSelfGovernanceStatus(env);
    // The observations are not an input to the gate in either direction.
    expect(snapshot.canSelfModify).toBe(true);
  });

  it('produces the same verdict with a healthy host and with no observations at all', async () => {
    buildSelfGovernanceSnapshot.mockReturnValue(snapshotWith(true));
    observeResources.mockResolvedValue(HEALTHY_HOST);
    const withHealthy = await runMemphisSelfGovernanceStatus(env);
    observeResources.mockResolvedValue(UNOBSERVABLE);
    const withUnobservable = await runMemphisSelfGovernanceStatus(env);
    expect(withHealthy.canSelfModify).toBe(withUnobservable.canSelfModify);
    expect(withHealthy.canSelfRecover).toBe(withUnobservable.canSelfRecover);
    expect(withHealthy.capable).toBe(withUnobservable.capable);
    expect(withHealthy.blockingReasons).toEqual(withUnobservable.blockingReasons);
  });
});
