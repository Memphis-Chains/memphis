import { describe, expect, it } from 'vitest';

import { getAppVersion } from '../../src/config/paths.js';
import { runCli } from '../helpers/cli.js';

describe('CLI health', () => {
  it('prints JSON for health command', async () => {
    const out = await runCli(['health', '--json'], {
      env: { DEFAULT_PROVIDER: 'local-fallback' },
    });

    const data = JSON.parse(out);
    expect(data.status).toBe('ok');
    expect(data.service).toBe('memphis');
    expect(data.version).toBe(getAppVersion());
  });
});
