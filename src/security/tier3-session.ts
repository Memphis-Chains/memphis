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
import {
  clearPersistedSessions,
  loadPersistedSessions,
  persistSessions,
} from './tier3-session-persistence.js';
import { validateOperatorPassphrase } from '../infra/auth/operator-gate.js';
import { writeSecurityAudit } from '../infra/logging/security-audit.js';

export const TIER_3_TTL_MS = 3 * 60 * 60 * 1000;
// Pre-expiry warning lead time. Default 5 min before expiry — matches
// "operator can finish what they're doing or re-elevate" UX. Override
// via MEMPHIS_TIER3_WARN_MS for test/demo flows.
const TIER_3_WARN_LEAD_MS_DEFAULT = 5 * 60 * 1000;

export type Tier3Surface = 'tui' | 'telegram' | 'http' | 'cli';

export interface Tier3Session {
  surface: Tier3Surface;
  actorId: string;
  tier: 3;
  grantedAt: number;
  expiresAt: number;
}

export type Tier3LifecycleEvent =
  | { kind: 'expiring-soon'; session: Tier3Session; remainingMs: number }
  | { kind: 'expired'; session: Tier3Session }
  | { kind: 'revoked'; session: Tier3Session; reason: string };

export type Tier3LifecycleListener = (event: Tier3LifecycleEvent) => void;

const lifecycleListeners = new Set<Tier3LifecycleListener>();
const scheduledTimers = new Map<string, { warn?: NodeJS.Timeout; expire?: NodeJS.Timeout }>();

// In-memory session map. Hydrated at module load from
// `tier3-session-persistence.ts` (disk-backed JSON file) so grants
// survive daemon restart. Hot path operations (grant/revoke/expire)
// mirror to disk through `persistAfterChange()` below.
const sessions = new Map<string, Tier3Session>();

// Hydrate from disk on module load. Module-level side-effect is
// intentional: importing this module is "I want tier-3 session
// state" and we hide the load cost there rather than racing it later.
// Failures swallow to empty (logged) — daemon never fails to start
// because of a corrupt state file.
function hydrateFromDisk(rawEnv: NodeJS.ProcessEnv = process.env): void {
  const restored = loadPersistedSessions(rawEnv);
  for (const session of restored) {
    sessions.set(sessionKey(session.surface, session.actorId), session);
  }
}
hydrateFromDisk();

function persistAfterChange(rawEnv: NodeJS.ProcessEnv = process.env): void {
  persistSessions(sessions, rawEnv);
}

/**
 * Register a callback to be invoked when a tier-3 session approaches
 * or hits expiry. Each surface (telegram/tui/http) wires its own
 * listener so the operator gets an active "tier 3 wygasł" message
 * instead of silent expiry that's only discoverable on the next denied
 * action. Returns an unsubscribe function.
 */
export function subscribeTier3Lifecycle(listener: Tier3LifecycleListener): () => void {
  lifecycleListeners.add(listener);
  return () => {
    lifecycleListeners.delete(listener);
  };
}

function notifyLifecycle(event: Tier3LifecycleEvent): void {
  for (const listener of lifecycleListeners) {
    try {
      listener(event);
    } catch {
      // Listeners must not throw; swallow to keep the runtime alive.
    }
  }
}

function clearTimers(key: string): void {
  const timers = scheduledTimers.get(key);
  if (!timers) return;
  if (timers.warn) clearTimeout(timers.warn);
  if (timers.expire) clearTimeout(timers.expire);
  scheduledTimers.delete(key);
}

function scheduleLifecycleTimers(
  key: string,
  session: Tier3Session,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  clearTimers(key);
  const nowMs = now();
  const expireDelay = Math.max(0, session.expiresAt - nowMs);
  // Configurable warn lead time. Read once per scheduling so test
  // fixtures can vary it per session.
  const warnLeadRaw = (rawEnv.MEMPHIS_TIER3_WARN_MS ?? '').trim();
  let warnLead = TIER_3_WARN_LEAD_MS_DEFAULT;
  if (warnLeadRaw) {
    const parsed = Number(warnLeadRaw);
    if (Number.isFinite(parsed) && parsed >= 0) warnLead = parsed;
  }
  const warnDelay = expireDelay - warnLead;

  const timers: { warn?: NodeJS.Timeout; expire?: NodeJS.Timeout } = {};
  if (warnDelay > 0 && warnLead > 0) {
    timers.warn = setTimeout(() => {
      // Only fire if session still alive — operator may have revoked.
      const current = sessions.get(key);
      if (!current) return;
      notifyLifecycle({
        kind: 'expiring-soon',
        session: current,
        remainingMs: current.expiresAt - now(),
      });
    }, warnDelay);
    timers.warn.unref?.();
  }
  timers.expire = setTimeout(() => {
    const current = sessions.get(key);
    if (!current) return;
    sessions.delete(key);
    persistAfterChange(rawEnv);
    scheduledTimers.delete(key);
    writeSecurityAudit(
      {
        action: 'tier3-expire',
        status: 'allowed',
        details: {
          surface: current.surface,
          actorId: current.actorId,
          grantedAt: new Date(current.grantedAt).toISOString(),
          expiredAt: new Date(current.expiresAt).toISOString(),
          trigger: 'timer',
        },
      },
      rawEnv,
    );
    notifyLifecycle({ kind: 'expired', session: current });
  }, expireDelay);
  timers.expire.unref?.();
  scheduledTimers.set(key, timers);
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

// `sessions` Map is now declared near the top of this module so the
// `hydrateFromDisk()` initializer can populate it before any caller
// touches the Map. See lines 38-66 for the persistence wiring.

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
    persistAfterChange(rawEnv);
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
  const key = sessionKey(surface, actorId);
  sessions.set(key, session);
  persistAfterChange(rawEnv);
  // Sprint ν: schedule active warn + expire so the operator's surface
  // gets pinged instead of discovering the expiry on the next denied
  // action. Replaces any existing timers on re-elevation.
  scheduleLifecycleTimers(key, session, rawEnv);

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
  persistAfterChange(rawEnv);
  clearTimers(key);
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
  notifyLifecycle({ kind: 'revoked', session, reason });
  return true;
}

/**
 * Test helper: wipe all sessions. Not exported from the package barrel —
 * only used by unit tests.
 */
export function __resetTier3SessionsForTests(): void {
  sessions.clear();
  // Wipe disk-backed state too so tests don't bleed sessions between
  // runs. Honors MEMPHIS_TIER3_PERSIST=0 (no-op).
  clearPersistedSessions();
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
  let didEvict = false;
  for (const [key, session] of sessions) {
    if (session.expiresAt > current) {
      // Persist any pending deletions before returning live signal.
      if (didEvict) persistAfterChange(rawEnv);
      return true;
    }
    sessions.delete(key);
    didEvict = true;
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
  if (didEvict) persistAfterChange(rawEnv);
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
  if (expired.length > 0) persistAfterChange(rawEnv);
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
