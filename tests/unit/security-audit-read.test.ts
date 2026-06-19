/**
 * `readRecentSecurityAuditEvents` — used by `memphis doctor` to surface
 * known-fork mitigations from the audit log. Verifies the reader
 * returns events newest-first, applies the predicate, and tolerates a
 * missing or partly-corrupt log file.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  readRecentSecurityAuditEvents,
  writeSecurityAudit,
} from '../../src/infra/logging/security-audit.js';

describe('readRecentSecurityAuditEvents', () => {
  let dataDir: string;
  let auditPath: string;
  let envOverride: NodeJS.ProcessEnv;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'memphis-audit-read-'));
    auditPath = join(dataDir, 'audit-log.jsonl');
    envOverride = {
      MEMPHIS_DATA_DIR: dataDir,
      MEMPHIS_SECURITY_AUDIT_LOG_PATH: auditPath,
      MEMPHIS_TEST_ALLOW_AUDIT_WRITE: '1',
    };
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns empty when audit log is missing', () => {
    const events = readRecentSecurityAuditEvents(() => true, 10, envOverride);
    expect(events).toEqual([]);
  });

  it('returns events newest-first up to the limit', () => {
    writeSecurityAudit({ action: 'a.one', status: 'allowed' }, envOverride);
    writeSecurityAudit({ action: 'a.two', status: 'allowed' }, envOverride);
    writeSecurityAudit({ action: 'a.three', status: 'allowed' }, envOverride);

    const events = readRecentSecurityAuditEvents(() => true, 2, envOverride);
    expect(events).toHaveLength(2);
    expect(events[0].action).toBe('a.three');
    expect(events[1].action).toBe('a.two');
  });

  it('applies the predicate filter', () => {
    writeSecurityAudit({ action: 'irrelevant.one', status: 'allowed' }, envOverride);
    writeSecurityAudit(
      {
        action: 'chain.verify.startup',
        status: 'mitigated',
        details: { chain: 'system', block: 1853 },
      },
      envOverride,
    );
    writeSecurityAudit({ action: 'irrelevant.two', status: 'allowed' }, envOverride);

    const events = readRecentSecurityAuditEvents(
      (e) => e.action === 'chain.verify.startup' && e.status === 'mitigated',
      10,
      envOverride,
    );
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({ chain: 'system', block: 1853 });
  });

  it('skips malformed lines without throwing', () => {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      auditPath,
      '{"ts":"2026-01-01T00:00:00Z","action":"good.one","status":"allowed"}\n' +
        'this line is not json at all\n' +
        '{"ts":"2026-01-02T00:00:00Z","action":"good.two","status":"allowed"}\n',
    );
    const events = readRecentSecurityAuditEvents(() => true, 10, envOverride);
    // Order is newest-first: good.two before good.one (line 3 read before line 1).
    expect(events.map((e) => e.action)).toEqual(['good.two', 'good.one']);
  });

  it('returns empty when limit is zero or negative', () => {
    writeSecurityAudit({ action: 'a.one', status: 'allowed' }, envOverride);
    expect(readRecentSecurityAuditEvents(() => true, 0, envOverride)).toEqual([]);
    expect(readRecentSecurityAuditEvents(() => true, -1, envOverride)).toEqual([]);
  });
});
