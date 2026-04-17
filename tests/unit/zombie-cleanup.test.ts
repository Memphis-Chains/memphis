import { describe, expect, it } from 'vitest';

import { isMemphisProcess } from '../../src/infra/ops/zombie-cleanup.ts';

/**
 * Regression net for #133. The old filter was
 *   if (cmd.includes('tsx') || cmd.includes('node') && cmd.includes('memphis'))
 * which parsed as `tsx || (node && memphis)` — ANY tsx process on the host
 * was killed, including unrelated dev work.
 */

describe('zombie-cleanup — isMemphisProcess (#133)', () => {
  it('matches node + memphis cmdline', () => {
    expect(isMemphisProcess('node /home/user/memphis/dist/index.js')).toBe(true);
  });

  it('matches tsx + memphis cmdline', () => {
    expect(isMemphisProcess('tsx /home/user/memphis/src/index.ts')).toBe(true);
  });

  it('does NOT match unrelated tsx process (regression)', () => {
    expect(isMemphisProcess('tsx /tmp/some-script.ts')).toBe(false);
    expect(isMemphisProcess('node /home/user/other-project/app.js')).toBe(false);
  });

  it('does NOT match non-tsx/node processes even if they contain "memphis"', () => {
    expect(isMemphisProcess('vim /home/user/memphis/README.md')).toBe(false);
    expect(isMemphisProcess('less /home/user/memphis/docs/api.md')).toBe(false);
  });

  it('does NOT match empty/garbage strings', () => {
    expect(isMemphisProcess('')).toBe(false);
    expect(isMemphisProcess('   ')).toBe(false);
  });
});
