import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { maybeRotateAuditLog, resolveAuditLogPath } from './audit-rotation.js';
import {
  emitAuditWriteGuardWarning,
  isAuditWriteAllowed,
} from './audit-write-guard.js';

export interface SecurityAuditEvent {
  action: string;
  status: 'allowed' | 'blocked' | 'error' | 'mitigated';
  ip?: string;
  route?: string;
  details?: Record<string, unknown>;
}

export interface PersistedSecurityAuditEvent extends SecurityAuditEvent {
  ts: string;
}

export function writeSecurityAudit(
  event: SecurityAuditEvent,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  // Block 1853 incident (2026-05-12) — refuse audit writes under
  // VITEST without explicit opt-in to keep tests from polluting the
  // operator's real audit log. Tests that legitimately need audit
  // writes set MEMPHIS_TEST_ALLOW_AUDIT_WRITE=1 in their setup.
  if (!isAuditWriteAllowed(rawEnv)) {
    emitAuditWriteGuardWarning(`writeSecurityAudit:${event.action}`);
    return;
  }
  try {
    const path = resolveAuditLogPath(rawEnv);
    mkdirSync(dirname(path), { recursive: true });
    try {
      maybeRotateAuditLog(rawEnv);
    } catch (rotationError) {
      process.stderr.write(
        `[security-audit] rotation failed (continuing without rotation): ${
          rotationError instanceof Error ? rotationError.message : 'unknown_error'
        }\n`,
      );
    }
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    appendFileSync(path, `${line}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(
      `[security-audit] failed to write event ${event.action}: ${error instanceof Error ? error.message : 'unknown_error'}\n`,
    );
  }
}

/**
 * Read the current (un-rotated) audit log and return the most recent
 * events matching `predicate`, newest first, up to `limit`. Returns an
 * empty array if the audit log doesn't exist yet or every line in the
 * file fails to parse as JSON (corrupt log).
 *
 * Reads only the active file, NOT the rotated archives — this is a
 * cheap "what just happened" helper for doctor/status surfaces, not a
 * forensic query API. Doctor-v2 uses this to count
 * `chain.verify.startup status:mitigated` events from the most recent
 * startup.
 */
export function readRecentSecurityAuditEvents(
  predicate: (event: PersistedSecurityAuditEvent) => boolean,
  limit: number,
  rawEnv: NodeJS.ProcessEnv = process.env,
): PersistedSecurityAuditEvent[] {
  if (limit <= 0) return [];
  const path = resolveAuditLogPath(rawEnv);
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const lines = raw.split('\n');
  const matches: PersistedSecurityAuditEvent[] = [];
  for (let i = lines.length - 1; i >= 0 && matches.length < limit; i -= 1) {
    const line = lines[i].trim();
    if (line.length === 0) continue;
    try {
      const event = JSON.parse(line) as PersistedSecurityAuditEvent;
      if (predicate(event)) matches.push(event);
    } catch {
      // skip malformed lines — caller asked for "recent valid events"
    }
  }
  return matches;
}
