import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../../src/infra/config/schema.js';
import { buildHealthPayload } from '../../src/infra/http/health.js';

const minimalConfig = {
  DATABASE_URL: 'file:./test.db',
} as unknown as AppConfig;

/**
 * Phase 4.2: /v1/ops/status surfaces a counts-only tier3 block.
 * Detailed session list stays behind /v1/ops/tier3/sessions.
 */
describe('Phase 4.2: /v1/ops/status tier3 snapshot', () => {
  it('exposes tier3.activeSessions and tier3.expiringWithinMinutes', async () => {
    const payload = await buildHealthPayload(minimalConfig);
    expect(payload.tier3).toBeDefined();
    expect(typeof payload.tier3.activeSessions).toBe('number');
    expect(typeof payload.tier3.expiringWithinMinutes).toBe('number');
    expect(payload.tier3.activeSessions).toBeGreaterThanOrEqual(0);
  });

  it('does not leak operator IDs or session metadata in /status', async () => {
    const payload = await buildHealthPayload(minimalConfig);
    const json = JSON.stringify(payload.tier3);
    // counts-only contract — no surface, actorId, sessionId, expiresAt etc.
    expect(json).not.toMatch(/"surface"/);
    expect(json).not.toMatch(/"actorId"/);
    expect(json).not.toMatch(/"sessionId"/);
    expect(json).not.toMatch(/"grantedAt"/);
    expect(json).not.toMatch(/"expiresAt"/);
  });
});
