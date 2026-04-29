/**
 * Tier-3 elevation sessions — time-limited, operator-passphrase-gated unlock
 * for fully unrestricted runtime (overwrite existing files anywhere, freeform
 * sudo, autonomy-mode=full).
 *
 * By default Memphis runs at tier 2: it can create new files anywhere on the
 * host, install packages, download things — but it cannot modify files that
 * already exist outside ~/memphis/. Tier 3 lifts that restriction for exactly
 * 3 hours and then auto-reverts.
 *
 * Grants and revocations are audited via writeSecurityAudit().
 */
import { validateOperatorPassphrase } from '../infra/auth/operator-gate.js';
import { writeSecurityAudit } from '../infra/logging/security-audit.js';

export const TIER_3_TTL_MS = 3 * 60 * 60 * 1000;

export type Tier3Surface = 'tui' | 'telegram' | 'http' | 'cli';

export interface Tier3Session {
  surface: Tier3Surface;
  actorId: string;
  tier: 3;
  grantedAt: number;
  expiresAt: number;
}

export interface Tier3ElevationRequest {
  surface: Tier3Surface;
  actorId: string;
  passphrase: string;
  rawEnv?: NodeJS.ProcessEnv;
}

export type Tier3ElevationResult =
  | { ok: true; session: Tier3Session }
  | { ok: false; reason: 'bad-passphrase' | 'rate-limited' | 'not-configured'; message: string };

const sessions = new Map<string, Tier3Session>();

function sessionKey(surface: Tier3Surface, actorId: string): string {
  return `${surface}:${actorId}`;
}

function now(): number {
  return Date.now();
}

function expireIfStale(
  session: Tier3Session,
  key: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Tier3Session | null {
  if (session.expiresAt <= now()) {
    sessions.delete(key);
    writeSecurityAudit(
      {
        action: 'tier3-expire',
        status: 'allowed',
        details: {
          surface: session.surface,
          actorId: session.actorId,
          grantedAt: new Date(session.grantedAt).toISOString(),
          expiredAt: new Date(session.expiresAt).toISOString(),
        },
      },
      rawEnv,
    );
    return null;
  }
  return session;
}

/**
 * Request a tier-3 elevation. Validates the operator passphrase via
 * validateOperatorPassphrase(). On success, installs a session that expires
 * TIER_3_TTL_MS from now. Every outcome (grant, bad-passphrase, rate-limit,
 * not-configured) is audited.
 */
export function requestTier3Elevation(request: Tier3ElevationRequest): Tier3ElevationResult {
  const { surface, actorId, passphrase, rawEnv = process.env } = request;

  let valid: boolean;
  try {
    valid = validateOperatorPassphrase(passphrase, rawEnv);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'rate-limited';
    writeSecurityAudit(
      {
        action: 'tier3-deny',
        status: 'blocked',
        details: { surface, actorId, reason: 'rate-limited', message },
      },
      rawEnv,
    );
    return { ok: false, reason: 'rate-limited', message };
  }

  if (!valid) {
    writeSecurityAudit(
      {
        action: 'tier3-deny',
        status: 'blocked',
        details: { surface, actorId, reason: 'bad-passphrase' },
      },
      rawEnv,
    );
    return {
      ok: false,
      reason: 'bad-passphrase',
      message:
        'Invalid operator passphrase. Tier 3 requires the passphrase you set during `memphis init`.',
    };
  }

  const grantedAt = now();
  const session: Tier3Session = {
    surface,
    actorId,
    tier: 3,
    grantedAt,
    expiresAt: grantedAt + TIER_3_TTL_MS,
  };
  sessions.set(sessionKey(surface, actorId), session);

  writeSecurityAudit(
    {
      action: 'tier3-grant',
      status: 'allowed',
      details: {
        surface,
        actorId,
        grantedAt: new Date(grantedAt).toISOString(),
        expiresAt: new Date(session.expiresAt).toISOString(),
        ttlMs: TIER_3_TTL_MS,
      },
    },
    rawEnv,
  );

  return { ok: true, session };
}

/**
 * Return the active tier-3 session for {surface, actorId}, or null if none
 * or expired. Automatically evicts expired sessions (and audits the
 * auto-expiry on first check after the deadline).
 */
export function getActiveTier3Session(
  surface: Tier3Surface,
  actorId: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Tier3Session | null {
  const key = sessionKey(surface, actorId);
  const session = sessions.get(key);
  if (!session) return null;
  return expireIfStale(session, key, rawEnv);
}

/**
 * Manually revoke an active tier-3 session. No-op (returns false) if there
 * is no active session. Audited when a session is actually revoked.
 */
export function revokeTier3Session(
  surface: Tier3Surface,
  actorId: string,
  reason = 'operator-request',
  rawEnv: NodeJS.ProcessEnv = process.env,
): boolean {
  const key = sessionKey(surface, actorId);
  const session = sessions.get(key);
  if (!session) return false;
  sessions.delete(key);
  writeSecurityAudit(
    {
      action: 'tier3-revoke',
      status: 'allowed',
      details: {
        surface,
        actorId,
        reason,
        grantedAt: new Date(session.grantedAt).toISOString(),
        revokedAt: new Date(now()).toISOString(),
      },
    },
    rawEnv,
  );
  return true;
}

/**
 * Test helper: wipe all sessions. Not exported from the package barrel —
 * only used by unit tests.
 */
export function __resetTier3SessionsForTests(): void {
  sessions.clear();
}

/**
 * Test helper: inject a session bypassing the operator-passphrase flow.
 * Lets unit tests for surface-facing flows assert tier-gated behavior
 * without standing up a real operator config.
 */
export function __seedTier3SessionForTests(
  surface: Tier3Surface,
  actorId: string,
  ttlMs: number = TIER_3_TTL_MS,
): Tier3Session {
  const session: Tier3Session = {
    surface,
    actorId,
    tier: 3,
    grantedAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  };
  sessions.set(sessionKey(surface, actorId), session);
  return session;
}

/**
 * True if at least one tier-3 session is currently active in this process.
 * Used as a secondary signal for tools that can't easily plumb rawEnv but
 * still need to respect the bypass. Surface-level policy enforcement is the
 * primary gate; this is an in-process fallback.
 */
export function hasAnyActiveTier3Session(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  const current = now();
  for (const [key, session] of sessions) {
    if (session.expiresAt > current) return true;
    sessions.delete(key);
    writeSecurityAudit(
      {
        action: 'tier3-expire',
        status: 'allowed',
        details: {
          surface: session.surface,
          actorId: session.actorId,
          grantedAt: new Date(session.grantedAt).toISOString(),
          expiredAt: new Date(session.expiresAt).toISOString(),
        },
      },
      rawEnv,
    );
  }
  return false;
}

/**
 * Snapshot of every currently-active tier-3 session in this process.
 *
 * Side effect: evicts (and audits) any session whose deadline has passed,
 * matching the behavior of `getActiveTier3Session` and
 * `hasAnyActiveTier3Session` for individual reads.
 *
 * Used by the HTTP `/v1/ops/tier3/sessions` endpoint to feed the
 * `memphis tier status` CLI. Not intended for routing/policy decisions —
 * those should go through `getActiveTier3Session(surface, actorId)`.
 */
export function listActiveTier3Sessions(
  rawEnv: NodeJS.ProcessEnv = process.env,
): Tier3Session[] {
  const current = now();
  const active: Tier3Session[] = [];
  // Two-phase to keep audit-log emission idempotent: first collect alive
  // and dead, then evict + audit dead. Mirrors hasAnyActiveTier3Session's
  // delete-and-audit shape but enumerates everything before returning so
  // the caller sees a stable snapshot.
  const expired: Array<[string, Tier3Session]> = [];
  for (const [key, session] of sessions) {
    if (session.expiresAt > current) {
      active.push(session);
    } else {
      expired.push([key, session]);
    }
  }
  for (const [key, session] of expired) {
    sessions.delete(key);
    writeSecurityAudit(
      {
        action: 'tier3-expire',
        status: 'allowed',
        details: {
          surface: session.surface,
          actorId: session.actorId,
          grantedAt: new Date(session.grantedAt).toISOString(),
          expiredAt: new Date(session.expiresAt).toISOString(),
        },
      },
      rawEnv,
    );
  }
  return active;
}

/**
 * Build the rawEnv overrides that should be merged into turn-runtime
 * processing when a tier-3 session is active. Returns an empty object if
 * no session is active.
 *
 * The overrides:
 *   - bump the surface's MAX_TOOL_TIER to 3
 *   - set MEMPHIS_AUTONOMY_MODE=full (flips restrictedMode=false)
 *   - set MEMPHIS_TIER3_FS_UNRESTRICTED=true (fs-permission bypass)
 */
export function buildTier3EnvOverride(
  surface: Tier3Surface,
  actorId: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const session = getActiveTier3Session(surface, actorId, rawEnv);
  if (!session) return {};
  const slug = surface.toUpperCase();
  return {
    [`MEMPHIS_SURFACE_${slug}_MAX_TOOL_TIER`]: '3',
    MEMPHIS_AUTONOMY_MODE: 'full',
    MEMPHIS_TIER3_FS_UNRESTRICTED: 'true',
  };
}

/**
 * Minutes remaining until tier-3 session expires (0 if not active).
 */
export function getTier3RemainingMs(
  surface: Tier3Surface,
  actorId: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): number {
  const session = getActiveTier3Session(surface, actorId, rawEnv);
  if (!session) return 0;
  return Math.max(0, session.expiresAt - now());
}
