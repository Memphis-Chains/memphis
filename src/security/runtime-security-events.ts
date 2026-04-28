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
        // Wiring W6 fix: was 'security_event', which is NOT in the Rust
        // block_types enum (journal | ask | decision | system |
        // system_event | insight | tool_call | tool_result | error |
        // case | wallet_tx_*). Every emitRuntimeSecurityEvent call
        // since this function landed has been failing the Rust schema
        // validator silently. Sprint 2.4 (#328) surfaced the failures
        // to stderr; THIS sprint fixes the underlying bug — switch to
        // the valid `system_event` variant + tag with `security` so
        // chain consumers can still filter to security-only events.
        type: 'system_event',
        action: event.action,
        status: event.status,
        details,
        tags: ['security', `status:${event.status}`],
        timestamp: new Date().toISOString(),
      },
      rawEnv,
    );
  } catch (err) {
    // Security events must never fail closed on audit persistence —
    // writeSecurityAudit (above) is the primary durability path; this
    // appendBlock is the chain-replicated mirror. Sprint 2.4: surface
    // the failure to stderr instead of total silence so operators can
    // see chain-side audit drift in PULSE.md / journalctl.
    process.stderr.write(
      `[memphis-security] chain append failed for security event ${event.action}: ${
        err instanceof Error ? err.message : String(err)
      } — primary security-audit log unaffected\n`,
    );
  }
}
