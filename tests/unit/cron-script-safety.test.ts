import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const CRONS_DIR = join(process.cwd(), 'crons');

describe('cron script safety', () => {
  it('does not directly exec a cron script into itself', () => {
    const violations = readdirSync(CRONS_DIR)
      .filter((name) => name.endsWith('.sh'))
      .filter((name) => {
        const source = readFileSync(join(CRONS_DIR, name), 'utf8');
        const executableLines = source
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line && !line.startsWith('#'));
        return executableLines.some(
          (line) =>
            line.startsWith('exec ') &&
            (line.includes(`/crons/${name}`) || line.includes(`./${basename(name)}`)),
        );
      });

    expect(violations).toEqual([]);
  });

  it('guards the daily briefing against overlap, recursion, and unbounded execution', () => {
    const source = readFileSync(join(CRONS_DIR, 'daily-9am-briefing.sh'), 'utf8');

    expect(source).toContain('refusing recursive self-execution');
    expect(source).toContain('flock -n');
    expect(source).toContain('timeout --signal=TERM --kill-after=10s');
    expect(source).toContain('morning-report.sh');
  });
});
