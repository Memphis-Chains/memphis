import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { searchAuditLog } from '../../src/infra/logging/audit-search.js';

/**
 * Regression net for Codex P2: lexicographic timestamp comparison in
 * audit-search was wrong around boundaries involving different ISO shapes.
 * A record at `2026-04-13T12:34:56.123Z` must be considered later than a
 * since filter of `2026-04-13T12:34:56Z`, which string-compare got wrong
 * because '5' > '.' in ASCII.
 */

interface TestEnv {
  dataDir: string;
  logPath: string;
  prevEnv: NodeJS.ProcessEnv;
}

function setup(lines: string[]): TestEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'memphis-audit-search-'));
  const logPath = join(dataDir, 'security-audit.jsonl');
  const prevEnv = { ...process.env };
  process.env.MEMPHIS_SECURITY_AUDIT_LOG_PATH = logPath;
  writeFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
  return { dataDir, logPath, prevEnv };
}

function tearDown(env: TestEnv): void {
  rmSync(env.dataDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in env.prevEnv)) delete process.env[key];
  }
  Object.assign(process.env, env.prevEnv);
}

function entry(ts: string, action = 'test.action', status = 'allowed'): string {
  return JSON.stringify({ ts, action, status });
}

describe('searchAuditLog — timestamp filter robustness', () => {
  let env: TestEnv;

  afterEach(() => {
    if (env) tearDown(env);
  });

  it('matches records even when the record timestamp has finer precision than `since`', async () => {
    env = setup([
      entry('2026-04-13T12:34:55.500Z'),
      entry('2026-04-13T12:34:56.123Z'),
      entry('2026-04-13T12:34:57.000Z'),
    ]);
    const result = await searchAuditLog({ since: '2026-04-13T12:34:56Z' });
    expect(result.records.length).toBe(2);
  });

  it('does not mis-order when `since` uses a timezone offset', async () => {
    env = setup([
      entry('2026-04-13T12:00:00Z'),
      entry('2026-04-13T14:00:00Z'),
      entry('2026-04-13T16:00:00Z'),
    ]);
    // 14:00 UTC == 16:00+02:00; records at 14:00Z and 16:00Z must match
    const result = await searchAuditLog({ since: '2026-04-13T16:00:00+02:00' });
    expect(result.records.length).toBe(2);
  });

  it('until filter handles sub-second precision correctly', async () => {
    env = setup([
      entry('2026-04-13T12:34:55.500Z'),
      entry('2026-04-13T12:34:56.123Z'),
      entry('2026-04-13T12:34:57.000Z'),
    ]);
    const result = await searchAuditLog({ until: '2026-04-13T12:34:56Z' });
    // records strictly > `until` must be excluded: 56.123 and 57.000
    expect(result.records.map((r) => r.ts)).toEqual(['2026-04-13T12:34:55.500Z']);
  });
});
