import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { appendDecisionAudit, readDecisionAudit } from '../../src/core/decision-audit-log.js';

describe('decision audit log', () => {
  it('appends and reads events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-decision-audit-'));
    try {
      const path = join(dir, 'audit.jsonl');
      appendDecisionAudit({ ts: '2026-01-01T00:00:00.000Z', decisionId: 'd1', action: 'create' }, path);
      appendDecisionAudit(
        { ts: '2026-01-01T00:00:01.000Z', decisionId: 'd1', action: 'transition', from: 'proposed', to: 'accepted' },
        path,
      );
      const events = readDecisionAudit(path);
      expect(events).toHaveLength(2);
      expect(events[1]?.to).toBe('accepted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
