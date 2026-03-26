import { writeSecurityAudit } from '../infra/logging/security-audit.js';
import { appendBlock } from '../infra/storage/chain-adapter.js';

export type RuntimeSecurityStatus = 'allowed' | 'blocked' | 'error';

export interface RuntimeSecurityEvent {
  action: string;
  status: RuntimeSecurityStatus;
  details?: Record<string, unknown>;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > 300 ? `${value.slice(0, 300)}...` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => sanitizeValue(item));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 20)
        .map(([key, inner]) => [key, sanitizeValue(inner)]),
    );
  }
  return value;
}

export async function emitRuntimeSecurityEvent(
  event: RuntimeSecurityEvent,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const details = sanitizeValue(event.details ?? {}) as Record<string, unknown>;

  writeSecurityAudit(
    {
      action: event.action,
      status: event.status,
      details,
    },
    rawEnv,
  );

  try {
    await appendBlock(
      'system',
      {
        type: 'security_event',
        action: event.action,
        status: event.status,
        details,
        timestamp: new Date().toISOString(),
      },
      rawEnv,
    );
  } catch {
    // Security events must never fail closed on audit persistence.
  }
}
