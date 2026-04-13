/**
 * Self-restart engine.
 *
 * Every operator surface (Telegram, TUI host, HTTP, MCP, CLI) funnels
 * into `requestRestart()` here. The engine handles the universal half
 * of the restart contract:
 *
 *   1. Validates a tier-3 session for the calling actor.
 *   2. Writes a `system.restart.requested` security audit entry.
 *   3. Triggers a drain on registered in-flight turn controllers,
 *      bounded by `MEMPHIS_RESTART_DRAIN_TIMEOUT_MS`.
 *   4. Writes a final PULSE entry with `event=restart` so after the
 *      process comes back, the PULSE history shows a clean seam
 *      rather than a crash-shaped gap.
 *   5. Detects whether a process supervisor (systemd, memphis-service
 *      unit, PM2) will bring the process back when it exits; if yes,
 *      calls `process.exit(0)`. If no, refuses unless the operator
 *      has explicitly opted in with `MEMPHIS_RESTART_ALLOW_SUICIDE=true`.
 *
 * The surface-facing code is deliberately thin: it checks tier,
 * calls requestRestart, reports the outcome. Everything destructive
 * lives in this one module so the audit trail + supervisor-detection
 * logic stay in exactly one place.
 */

import { existsSync } from 'node:fs';

import { writePulseEvent } from './heartbeat-watchdog.js';
import { AppError } from '../../core/errors.js';
import {
  getActiveTier3Session,
  type Tier3Surface,
} from '../../security/tier3-session.js';
import { writeSecurityAudit } from '../logging/security-audit.js';

export const DEFAULT_DRAIN_TIMEOUT_MS = 10_000;
const SYSTEMD_UNIT_CANDIDATES = [
  '/etc/systemd/system/memphis.service',
  '/lib/systemd/system/memphis.service',
];

export type SupervisorKind = 'systemd' | 'memphis-service' | 'pm2' | null;

export interface SupervisorDetection {
  kind: SupervisorKind;
  detail: string;
}

/**
 * Best-effort inspection of the surrounding process management.
 * Returns `null` when we believe the process is running unsupervised
 * (e.g. `npm run dev`, direct `node` invocation) so `process.exit`
 * would leave the agent down until an operator manually restarts.
 */
export function detectSupervisor(
  rawEnv: NodeJS.ProcessEnv = process.env,
): SupervisorDetection {
  // systemd sets NOTIFY_SOCKET when running units under it
  if (rawEnv.NOTIFY_SOCKET) {
    return { kind: 'systemd', detail: `NOTIFY_SOCKET=${rawEnv.NOTIFY_SOCKET}` };
  }
  // systemd also sets INVOCATION_ID for its processes
  if (rawEnv.INVOCATION_ID) {
    return { kind: 'systemd', detail: `INVOCATION_ID=${rawEnv.INVOCATION_ID}` };
  }
  // PM2 sets pm_id in env
  if (rawEnv.pm_id || rawEnv.PM2_HOME) {
    return { kind: 'pm2', detail: `pm2 managed (pm_id=${rawEnv.pm_id ?? 'unknown'})` };
  }
  // memphis-service installer lays down a systemd unit file
  for (const path of SYSTEMD_UNIT_CANDIDATES) {
    if (existsSync(path)) {
      return {
        kind: 'memphis-service',
        detail: `memphis service unit installed at ${path}`,
      };
    }
  }
  return { kind: null, detail: 'no supervisor detected' };
}

const turnControllers = new Set<AbortController>();

/**
 * Turn runtime calls this to register an abort controller so a pending
 * restart can signal in-flight turns to bail early instead of
 * holding the drain window open.
 */
export function registerTurnController(controller: AbortController): void {
  turnControllers.add(controller);
}

export function unregisterTurnController(controller: AbortController): void {
  turnControllers.delete(controller);
}

export function activeTurnCount(): number {
  return turnControllers.size;
}

function signalDrain(): number {
  const count = turnControllers.size;
  for (const controller of turnControllers) {
    try {
      controller.abort(new AppError('VALIDATION_ERROR', 'restart draining in-flight turn', 503));
    } catch {
      // abort failures are best-effort — we're tearing down anyway
    }
  }
  return count;
}

async function waitForDrain(timeoutMs: number): Promise<{ drained: boolean; remaining: number }> {
  if (turnControllers.size === 0) return { drained: true, remaining: 0 };
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (turnControllers.size === 0) return { drained: true, remaining: 0 };
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return { drained: turnControllers.size === 0, remaining: turnControllers.size };
}

export interface RequestRestartInput {
  /** Which surface initiated the restart. */
  surface: Tier3Surface;
  /** Stable actor id within the surface (chat id, operator id, ip, etc.). */
  actorId: string;
  /** Free-form operator reason, audited. */
  reason?: string;
  /** Override drain timeout; falls back to MEMPHIS_RESTART_DRAIN_TIMEOUT_MS or 10 s. */
  drainTimeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Injectable exit for tests — defaults to process.exit. */
  exitFn?: (code: number) => never;
  /** Injectable env. */
  rawEnv?: NodeJS.ProcessEnv;
  /** Injectable audit writer. */
  auditFn?: typeof writeSecurityAudit;
  /** Injectable PULSE writer. */
  pulseFn?: typeof writePulseEvent;
  /** Active surfaces to stamp into the final PULSE line (optional). */
  activeSurfaces?: string[];
}

export interface RestartRefusal {
  ok: false;
  reason: 'not-elevated' | 'no-supervisor';
  message: string;
  supervisor?: SupervisorDetection;
}

export interface RestartScheduled {
  ok: true;
  scheduledAt: string;
  drainTimeoutMs: number;
  supervisor: SupervisorDetection;
  drainedTurnCount: number;
  remainingTurnCount: number;
}

export type RestartOutcome = RestartScheduled | RestartRefusal;

function resolveDrainTimeout(input: RequestRestartInput): number {
  if (typeof input.drainTimeoutMs === 'number' && input.drainTimeoutMs >= 0) {
    return input.drainTimeoutMs;
  }
  const raw = (input.rawEnv ?? process.env).MEMPHIS_RESTART_DRAIN_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_DRAIN_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 300_000) return DEFAULT_DRAIN_TIMEOUT_MS;
  return parsed;
}

function allowSuicide(rawEnv: NodeJS.ProcessEnv): boolean {
  const raw = rawEnv.MEMPHIS_RESTART_ALLOW_SUICIDE?.trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

export async function requestRestart(input: RequestRestartInput): Promise<RestartOutcome> {
  const rawEnv = input.rawEnv ?? process.env;
  const audit = input.auditFn ?? writeSecurityAudit;
  const pulse = input.pulseFn ?? writePulseEvent;
  const nowFn = input.now ?? Date.now;
  const exitFn = input.exitFn ?? ((code: number) => process.exit(code));

  // 1. Tier-3 gate
  const session = getActiveTier3Session(input.surface, input.actorId, rawEnv);
  if (!session) {
    audit({
      action: 'system.restart.requested',
      status: 'blocked',
      details: {
        surface: input.surface,
        actor: input.actorId,
        reason: input.reason ?? null,
        blockedBy: 'no-tier3-session',
      },
    });
    return {
      ok: false,
      reason: 'not-elevated',
      message:
        'restart refused — tier-3 session required. Elevate with /tier 3 <passphrase> (Telegram) or security.tier.elevate (TUI).',
    };
  }

  const supervisor = detectSupervisor(rawEnv);
  const drainTimeoutMs = resolveDrainTimeout(input);

  // 2. Supervisor gate (fail before audit-as-allowed to keep the trail honest)
  if (supervisor.kind === null && !allowSuicide(rawEnv)) {
    audit({
      action: 'system.restart.requested',
      status: 'blocked',
      details: {
        surface: input.surface,
        actor: input.actorId,
        reason: input.reason ?? null,
        blockedBy: 'no-supervisor',
      },
    });
    return {
      ok: false,
      reason: 'no-supervisor',
      message:
        'restart refused — no supervisor detected (systemd/pm2/memphis-service). Set MEMPHIS_RESTART_ALLOW_SUICIDE=true to exit anyway; operator must manually restart.',
      supervisor,
    };
  }

  // 3. Audit as allowed
  audit({
    action: 'system.restart.requested',
    status: 'allowed',
    details: {
      surface: input.surface,
      actor: input.actorId,
      reason: input.reason ?? null,
      supervisor: supervisor.kind ?? 'allow-suicide',
      drainTimeoutMs,
    },
  });

  // 4. Drain in-flight turns
  const drainedTurnCount = signalDrain();
  const { remaining } = await waitForDrain(drainTimeoutMs);

  // 5. Final PULSE (keeps the heartbeat history continuous across restart)
  try {
    pulse({
      timestamp: new Date(nowFn()).toISOString(),
      event: 'heartbeat',
      health: 'healthy',
      uptimeSeconds: Math.floor(process.uptime()),
      detail: `restart surface=${input.surface} actor=${input.actorId} supervisor=${supervisor.kind ?? 'allow-suicide'}`,
      activeSurfaces: input.activeSurfaces,
    });
  } catch {
    // PULSE is best-effort; don't block restart on a disk write
  }

  // 6. Exit — caller can optionally read the scheduled descriptor before the
  //    event loop unwinds; on real runs process.exit is synchronous enough
  //    that any pending reply should already be on the wire. Tests stub exitFn.
  const outcome: RestartScheduled = {
    ok: true,
    scheduledAt: new Date(nowFn()).toISOString(),
    drainTimeoutMs,
    supervisor,
    drainedTurnCount,
    remainingTurnCount: remaining,
  };

  // Schedule the exit on the next tick so the caller can return the
  // outcome to the surface before we actually die.
  setImmediate(() => {
    exitFn(0);
  });

  return outcome;
}

/** Test-only: clear the turn-controller set. */
export function __resetTurnControllersForTests(): void {
  turnControllers.clear();
}
