import { appendFileSync, mkdirSync } from 'node:fs';
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
