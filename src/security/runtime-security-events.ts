import {
  emitAuditWriteGuardWarning,
  isAuditWriteAllowed,
} from '../infra/logging/audit-write-guard.js';
import { writeSecurityAudit } from '../infra/logging/security-audit.js';
import { appendBlock } from '../infra/storage/chain-adapter.js';

export type RuntimeSecurityStatus = 'allowed' | 'blocked' | 'error' | 'mitigated';

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

/**
 * Shape of the `system` chain block that carries a security event.
 *
 * `content` is not decoration: src/onboarding/first-run.ts:232-241
 * rejects any block whose `data.content` is not a string, marking the
 * runtime `legacy-migrateable` → `runtimeStatus: unhealthy` and blocking
 * `init` until `memphis repair runtime --force` runs. Security events
 * that omit it are therefore self-inflicted outages.
 */
export interface SecurityEventBlock {
  type: 'system_event';
  action: string;
  status: string;
  content: string;
  details: Record<string, unknown>;
  tags: string[];
  timestamp: string;
}

/**
 * Build the block payload. Exported so the shape contract is testable
 * without writing to a live chain.
 */
/**
 * Keys allowed into the chain block's `content` field.
 *
 * Everything else a caller passes is still preserved in `details`
 * (JSONL audit log, stderr on failure) — it just never reaches the
 * chain body, because chain content is semantically indexed and
 * searchable while the audit log is not.
 */
const CONTENT_SAFE_DETAIL_KEYS = [
  'surface',
  'flags',
  'contentHash',
  'provenance',
  'reason',
  'kind',
  'blockedCount',
] as const;

function pickContentSafeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CONTENT_SAFE_DETAIL_KEYS) {
    if (key in details) out[key] = details[key];
  }
  return out;
}

export function buildSecurityEventBlock(
  event: RuntimeSecurityEvent,
  details: Record<string, unknown> = (event.details ?? {}) as Record<string, unknown>,
): SecurityEventBlock {
  return {
    type: 'system_event',
    action: event.action,
    status: event.status,
    // Content is an ALLOWLIST projection, not a copy of `details`.
    // `details` is caller-controlled: a future call site could pass
    // `raw: <original prompt>` and the block would carry unredacted
    // text into the chain, which is then semantically indexed and
    // searchable. Only these keys ever reach `content`:
    //   surface   — which entry point saw it
    //   flags     — which patterns matched
    //   contentHash — sha256 of the original, for correlation
    //   provenance / reason / kind — non-content classification
    content: JSON.stringify({
      action: event.action,
      status: event.status,
      details: pickContentSafeDetails(details),
    }),
    details,
    tags: ['security', `status:${event.status}`],
    timestamp: new Date().toISOString(),
  };
}

/**
 * Runtime-side guard for the same predicate the onboarding check uses.
 * Throws instead of writing, so a malformed block never reaches the
 * chain in the first place.
 */
export function assertSecurityEventBlockShape(
  block: Partial<SecurityEventBlock>,
): asserts block is SecurityEventBlock {
  const ok =
    typeof block.type === 'string' &&
    block.type.trim().length > 0 &&
    typeof block.content === 'string' &&
    Array.isArray(block.tags) &&
    block.tags.every((t) => typeof t === 'string');
  if (!ok) {
    throw new Error(
      'security event block would be classified legacy-migrateable: ' +
        'src/onboarding/first-run.ts requires a non-empty type, a string content, and string[] tags',
    );
  }
}

export async function emitRuntimeSecurityEvent(
  event: RuntimeSecurityEvent,
  rawEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  // Block 1853 incident (2026-05-12) — short-circuit under VITEST so
  // tests can't accidentally append `self_modify.committed` (and
  // similar) events to the operator's live system chain. Tests that
  // intentionally exercise the audit path set
  // MEMPHIS_TEST_ALLOW_AUDIT_WRITE=1 in their setup.
  if (!isAuditWriteAllowed(rawEnv)) {
    emitAuditWriteGuardWarning(`emitRuntimeSecurityEvent:${event.action}`);
    return;
  }
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
    const block = buildSecurityEventBlock(event, details);
    // Fail before the write, not after: a malformed block would
    // otherwise land in the chain and pin runtimeStatus to unhealthy
    // until someone runs `repair runtime --force`.
    assertSecurityEventBlockShape(block);
    await appendBlock('system', { ...block }, rawEnv);
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
