import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface SecurityAuditEvent {
  action: string;
  status: 'allowed' | 'blocked' | 'error';
  ip?: string;
  route?: string;
  details?: Record<string, unknown>;
}

function auditLogPath(rawEnv: NodeJS.ProcessEnv): string {
  return resolve(rawEnv.MEMPHIS_SECURITY_AUDIT_LOG_PATH ?? 'data/security-audit.jsonl');
}

export function writeSecurityAudit(
  event: SecurityAuditEvent,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const path = auditLogPath(rawEnv);
    mkdirSync(dirname(path), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    appendFileSync(path, `${line}\n`, 'utf8');
  } catch (error) {
    // Never allow audit logging failures to crash request handling.
    process.stderr.write(
      `[security-audit] failed to write event ${event.action}: ${error instanceof Error ? error.message : 'unknown_error'}\n`,
    );
  }
}
