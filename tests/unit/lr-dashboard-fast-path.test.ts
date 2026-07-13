import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { handleLrDashboardFastPath } from '../../src/gateway/lr-dashboard-fast-path.js';

const timestamp = new Date('2026-07-08T11:03:00.000Z');

function testEnv(): NodeJS.ProcessEnv {
  return { MEMPHIS_DATA_DIR: join(mkdtempSync(join(tmpdir(), 'memphis-lr-fast-path-')), '.memphis') };
}

describe('LR Dashboard health fast path', () => {
  it('uses an explicit Polish date even when it appears before the pH value', () => {
    const result = handleLrDashboardFastPath({
      text: 'zapisz wynik z 7.07.2026: pH moczu 6.2',
      timestamp,
      rawEnv: testEnv(),
    });

    expect(result).toMatchObject({ handled: true, reply: expect.stringContaining('(2026-07-07)') });
  });

  it('uses an explicit ISO date even when it appears after the pH value', () => {
    const result = handleLrDashboardFastPath({
      text: 'zapisz pH moczu 6.2 z 2026-07-06',
      timestamp,
      rawEnv: testEnv(),
    });

    expect(result).toMatchObject({ handled: true, reply: expect.stringContaining('(2026-07-06)') });
  });

  it('does not write a bare save command from a prior conversation value', () => {
    expect(
      handleLrDashboardFastPath({ text: 'to zapisz', timestamp, rawEnv: testEnv() }),
    ).toEqual({ handled: false });
  });

  it.each([
    'zapisz pH moczu 15',
    'zapisz pH moczu 6.2 i pH moczu 6.4',
    'zapisz pH moczu około sześć',
  ])('falls back for ambiguous or out-of-range health data: %s', (text) => {
    expect(handleLrDashboardFastPath({ text, timestamp, rawEnv: testEnv() })).toEqual({
      handled: false,
    });
  });
});
