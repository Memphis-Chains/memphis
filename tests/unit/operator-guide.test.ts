import { describe, expect, it } from 'vitest';

import { buildOperatorGuide, renderOperatorGuideText } from '../../src/infra/operator-guide.js';

describe('operator guide', () => {
  it('describes tools, secrets, and memory runtime', () => {
    const guide = buildOperatorGuide({
      MEMPHIS_AGENT_NAME: 'Jawor',
      MEMPHIS_OWNER_NAME: 'Marcin',
      MEMPHIS_API_TOKEN: 'token',
      MEMPHIS_VAULT_PEPPER: 'memphis-super-secure-pepper',
      RUST_CHAIN_ENABLED: 'true',
      RUST_EMBED_PERSIST_ENABLED: 'true',
      RUST_EMBED_PERSIST_PATH: './data/embed-index.json',
    });

    expect(guide.sections.some((section) => section.title === 'Secrets')).toBe(true);
    expect(guide.sections.some((section) => section.title === 'Tools')).toBe(true);

    const rendered = renderOperatorGuideText({
      MEMPHIS_AGENT_NAME: 'Jawor',
      MEMPHIS_OWNER_NAME: 'Marcin',
      MEMPHIS_API_TOKEN: 'token',
      MEMPHIS_VAULT_PEPPER: 'memphis-super-secure-pepper',
      RUST_CHAIN_ENABLED: 'true',
      RUST_EMBED_PERSIST_ENABLED: 'true',
    });

    expect(rendered).toContain('Agent name: Jawor');
    expect(rendered).toContain('MEMPHIS_API_TOKEN: configured');
    expect(rendered).toContain('In-process tools:');
  });
});
