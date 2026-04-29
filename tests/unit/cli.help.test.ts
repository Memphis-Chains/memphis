import { describe, expect, it } from 'vitest';

import { runCli } from '../helpers/cli.js';

describe('CLI help truth', () => {
  it('promotes init and setup telegram while keeping legacy onboarding surfaces out of main help', async () => {
    const out = await runCli(['help']);

    expect(out).toContain('init [status]');
    expect(out).toContain('setup telegram');
    expect(out).toContain('skills list|show|install|create|validate|import');
    expect(out).not.toContain('configure [legacy/deprecated]');
    expect(out).not.toContain('onboarding wizard|bootstrap');
    expect(out).not.toContain('setup matrix');
  });
});
