import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { appendDecisionHistory, readDecisionHistory } from '../../src/core/decision-history-store.js';
import { createDecision } from '../../src/core/decision-lifecycle.js';

describe('decision history store', () => {
  it('appends snapshots and reads them back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mv4-decision-history-'));
    try {
      const path = join(dir, 'history.jsonl');
      appendDecisionHistory(createDecision({ id: 'd1', title: 'Pick provider' }), {
        path,
        chainRef: { chain: 'decision-history', index: 1, hash: 'abc' },
      });
      const entries = readDecisionHistory(path);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.decision.id).toBe('d1');
      expect(entries[0]?.chainRef?.hash).toBe('abc');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
