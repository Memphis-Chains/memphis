import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { maybeRotateAuditLog, resolveAuditLogPath } from './audit-rotation.js';

export interface SecurityAuditEvent {
  action: string;
  status: 'allowed' | 'blocked' | 'error';
  ip?: string;
  route?: string;
  details?: Record<string, unknown>;
}

export function writeSecurityAudit(
  event: SecurityAuditEvent,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
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
