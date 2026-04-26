/**
 * Unit tests for tier-3 elevation sessions.
 *
 * Covers: passphrase validation paths (grant, bad-passphrase, rate-limited),
 * TTL auto-expiry, manual revoke, cross-surface isolation, env overlay shape,
 * and audit events for every outcome.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearSessionAuth,
  generateSalt,
  hashWithSalt,
  saveOperatorConfig,
  type OperatorConfig,
} from '../../src/infra/auth/operator-gate.js';
import {
  __resetTier3SessionsForTests,
  __seedTier3SessionForTests,
  TIER_3_TTL_MS,
  buildTier3EnvOverride,
  getActiveTier3Session,
  getTier3RemainingMs,
  hasAnyActiveTier3Session,
  listActiveTier3Sessions,
  requestTier3Elevation,
  revokeTier3Session,
} from '../../src/security/tier3-session.js';

interface AuditLine {
  ts: string;
  action: string;
  status: 'allowed' | 'blocked' | 'error';
  details?: Record<string, unknown>;
}

let testDir: string;
let auditPath: string;
let testEnv: NodeJS.ProcessEnv;

function readAuditLines(): AuditLine[] {
  if (!existsSync(auditPath)) return [];
  const raw = readFileSync(auditPath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line) as AuditLine);
}

function provisionOperator(passphrase: string): void {
  const salt = generateSalt();
  const config: OperatorConfig = {
    schemaVersion: 1,
    passphraseHash: hashWithSalt(passphrase, salt),
    salt,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    recoveryQuestionHint: 'Test?',
    recoveryHash: hashWithSalt('answer', salt),
  };
  saveOperatorConfig(config, testEnv);
}

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `memphis-tier3-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  auditPath = join(testDir, 'security-audit.jsonl');
  testEnv = {
    MEMPHIS_DATA_DIR: testDir,
    MEMPHIS_SECURITY_AUDIT_LOG_PATH: auditPath,
  };
  __resetTier3SessionsForTests();
  clearSessionAuth();
});

afterEach(() => {
  vi.useRealTimers();
  __resetTier3SessionsForTests();
  clearSessionAuth();
  rmSync(testDir, { recursive: true, force: true });
});

describe('requestTier3Elevation', () => {
  it('grants a tier-3 session when passphrase is correct', () => {
    provisionOperator('correct-horse');

    const result = requestTier3Elevation({
      surface: 'tui',
      actorId: 'operator',
      passphrase: 'correct-horse',
      rawEnv: testEnv,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.tier).toBe(3);
    expect(result.session.surface).toBe('tui');
    expect(result.session.actorId).toBe('operator');
    expect(result.session.expiresAt - result.session.grantedAt).toBe(TIER_3_TTL_MS);

    const events = readAuditLines();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('tier3-grant');
    expect(events[0].status).toBe('allowed');
    expect(events[0].details?.surface).toBe('tui');
    expect(events[0].details?.actorId).toBe('operator');
    expect(events[0].details?.ttlMs).toBe(TIER_3_TTL_MS);
  });

  it('denies with bad-passphrase reason when passphrase is wrong', () => {
    provisionOperator('correct-horse');

    const result = requestTier3Elevation({
      surface: 'telegram',
      actorId: '12345',
      passphrase: 'not-it',
      rawEnv: testEnv,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('bad-passphrase');
    expect(result.message).toContain('Invalid operator passphrase');

    const events = readAuditLines();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('tier3-deny');
    expect(events[0].status).toBe('blocked');
    expect(events[0].details?.reason).toBe('bad-passphrase');
    expect(events[0].details?.surface).toBe('telegram');
    expect(events[0].details?.actorId).toBe('12345');
  });

  it('denies with rate-limited reason after 5 wrong attempts', () => {
    provisionOperator('correct-horse');

    for (let i = 0; i < 5; i += 1) {
      const r = requestTier3Elevation({
        surface: 'tui',
        actorId: 'operator',
        passphrase: `wrong-${i}`,
        rawEnv: testEnv,
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('bad-passphrase');
    }

    const result = requestTier3Elevation({
      surface: 'tui',
      actorId: 'operator',
      passphrase: 'wrong-6',
      rawEnv: testEnv,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('rate-limited');

    const events = readAuditLines();
    const rateLimitedEvent = events[events.length - 1];
    expect(rateLimitedEvent.action).toBe('tier3-deny');
    expect(rateLimitedEvent.status).toBe('blocked');
    expect(rateLimitedEvent.details?.reason).toBe('rate-limited');
  });

  it('fails even when no operator is configured', () => {
    const result = requestTier3Elevation({
      surface: 'tui',
      actorId: 'operator',
      passphrase: 'anything',
      rawEnv: testEnv,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('bad-passphrase');
  });
});

describe('TTL auto-expiry', () => {
  it('keeps the session active right before expiresAt', () => {
    vi.useFakeTimers();
    const start = new Date('2026-04-13T10:00:00Z').getTime();
    vi.setSystemTime(start);

    provisionOperator('good-pass');

    const grant = requestTier3Elevation({
      surface: 'tui',
      actorId: 'operator',
      passphrase: 'good-pass',
      rawEnv: testEnv,
    });
    expect(grant.ok).toBe(true);

    vi.setSystemTime(start + TIER_3_TTL_MS - 1);
    expect(getActiveTier3Session('tui', 'operator', testEnv)).not.toBeNull();
    expect(hasAnyActiveTier3Session(testEnv)).toBe(true);
  });

  it('auto-evicts and audits tier3-expire on first check past deadline', () => {
    vi.useFakeTimers();
    const start = new Date('2026-04-13T10:00:00Z').getTime();
    vi.setSystemTime(start);

    provisionOperator('good-pass');

    requestTier3Elevation({
      surface: 'tui',
      actorId: 'operator',
      passphrase: 'good-pass',
      rawEnv: testEnv,
    });

    vi.setSystemTime(start + TIER_3_TTL_MS + 1);
    expect(getActiveTier3Session('tui', 'operator', testEnv)).toBeNull();
    expect(hasAnyActiveTier3Session(testEnv)).toBe(false);

    const expireEvents = readAuditLines().filter((e) => e.action === 'tier3-expire');
    expect(expireEvents).toHaveLength(1);
    expect(expireEvents[0].status).toBe('allowed');
    expect(expireEvents[0].details?.surface).toBe('tui');
    expect(expireEvents[0].details?.actorId).toBe('operator');
  });

  it('getTier3RemainingMs counts down toward zero', () => {
    vi.useFakeTimers();
    const start = new Date('2026-04-13T10:00:00Z').getTime();
    vi.setSystemTime(start);

    provisionOperator('good-pass');
    requestTier3Elevation({
      surface: 'tui',
      actorId: 'operator',
      passphrase: 'good-pass',
      rawEnv: testEnv,
    });

    expect(getTier3RemainingMs('tui', 'operator', testEnv)).toBe(TIER_3_TTL_MS);

    vi.setSystemTime(start + 60_000);
    expect(getTier3RemainingMs('tui', 'operator', testEnv)).toBe(TIER_3_TTL_MS - 60_000);

    vi.setSystemTime(start + TIER_3_TTL_MS + 1);
    expect(getTier3RemainingMs('tui', 'operator', testEnv)).toBe(0);
  });
});

describe('revokeTier3Session', () => {
  it('returns true and audits when a session was active', () => {
    provisionOperator('good-pass');
    requestTier3Elevation({
      surface: 'tui',
      actorId: 'operator',
      passphrase: 'good-pass',
      rawEnv: testEnv,
    });

    const revoked = revokeTier3Session('tui', 'operator', 'ui-click', testEnv);
    expect(revoked).toBe(true);
    expect(getActiveTier3Session('tui', 'operator', testEnv)).toBeNull();

    const revokeEvents = readAuditLines().filter((e) => e.action === 'tier3-revoke');
    expect(revokeEvents).toHaveLength(1);
    expect(revokeEvents[0].details?.reason).toBe('ui-click');
    expect(revokeEvents[0].details?.surface).toBe('tui');
  });

  it('returns false and does not audit when no session exists', () => {
    const revoked = revokeTier3Session('tui', 'ghost', 'ui-click', testEnv);
    expect(revoked).toBe(false);
    expect(readAuditLines().filter((e) => e.action === 'tier3-revoke')).toHaveLength(0);
  });
});

describe('cross-surface isolation', () => {
  it('grants independent sessions per (surface, actorId) pair', () => {
    provisionOperator('good-pass');

    requestTier3Elevation({
      surface: 'tui',
      actorId: 'alice',
      passphrase: 'good-pass',
      rawEnv: testEnv,
    });

    expect(getActiveTier3Session('tui', 'alice', testEnv)).not.toBeNull();
    expect(getActiveTier3Session('telegram', 'alice', testEnv)).toBeNull();
    expect(getActiveTier3Session('tui', 'bob', testEnv)).toBeNull();

    requestTier3Elevation({
      surface: 'telegram',
      actorId: 'alice',
      passphrase: 'good-pass',
      rawEnv: testEnv,
    });
    expect(getActiveTier3Session('telegram', 'alice', testEnv)).not.toBeNull();

    revokeTier3Session('tui', 'alice', 'test', testEnv);
    expect(getActiveTier3Session('tui', 'alice', testEnv)).toBeNull();
    expect(getActiveTier3Session('telegram', 'alice', testEnv)).not.toBeNull();
  });
});

describe('buildTier3EnvOverride', () => {
  it('returns an empty object when no session is active', () => {
    expect(buildTier3EnvOverride('tui', 'operator', testEnv)).toEqual({});
  });

  it('returns surface-specific max-tier + unrestricted flags when active', () => {
    provisionOperator('good-pass');
    requestTier3Elevation({
      surface: 'telegram',
      actorId: 'operator',
      passphrase: 'good-pass',
      rawEnv: testEnv,
    });

    const overrides = buildTier3EnvOverride('telegram', 'operator', testEnv);
    expect(overrides).toEqual({
      MEMPHIS_SURFACE_TELEGRAM_MAX_TOOL_TIER: '3',
      MEMPHIS_AUTONOMY_MODE: 'full',
      MEMPHIS_TIER3_FS_UNRESTRICTED: 'true',
    });
  });
});

describe('listActiveTier3Sessions', () => {
  it('returns empty array when no sessions are seeded', () => {
    expect(listActiveTier3Sessions(testEnv)).toEqual([]);
  });

  it('returns one entry per seeded session across surfaces', () => {
    __seedTier3SessionForTests('telegram', '1316033647');
    __seedTier3SessionForTests('tui', 'local');
    const result = listActiveTier3Sessions(testEnv);
    expect(result).toHaveLength(2);
    const surfaces = result.map((s) => s.surface).sort();
    expect(surfaces).toEqual(['telegram', 'tui']);
  });

  it('evicts expired sessions on read and audits each eviction once', () => {
    vi.useFakeTimers();
    const start = new Date('2026-04-13T10:00:00Z').getTime();
    vi.setSystemTime(start);

    __seedTier3SessionForTests('telegram', 'a', 1000);
    __seedTier3SessionForTests('tui', 'b', TIER_3_TTL_MS);

    vi.setSystemTime(start + 5000); // first session expired, second still alive
    const result = listActiveTier3Sessions(testEnv);
    expect(result).toHaveLength(1);
    expect(result[0].surface).toBe('tui');

    const expireEvents = readAuditLines().filter((e) => e.action === 'tier3-expire');
    expect(expireEvents).toHaveLength(1);
    expect(expireEvents[0].details?.surface).toBe('telegram');

    // Second call must NOT re-audit the same eviction (idempotency).
    listActiveTier3Sessions(testEnv);
    const expireAgain = readAuditLines().filter((e) => e.action === 'tier3-expire');
    expect(expireAgain).toHaveLength(1);
  });
});
