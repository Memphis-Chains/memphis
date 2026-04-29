import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildOperatorGuide,
  renderOperatorGuideText,
  renderSurfaceDesignGuideText,
} from '../../src/infra/operator-guide.js';

describe('operator guide', () => {
  it('describes tools, secrets, and memory runtime', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'memphis-guide-'));
    const guide = buildOperatorGuide({
      MEMPHIS_DATA_DIR: tempDir,
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
    expect(guide.sections.some((section) => section.title === 'Skills')).toBe(true);
    expect(guide.sections.some((section) => section.title === 'Surfaces')).toBe(true);

    const rendered = renderOperatorGuideText({
      MEMPHIS_DATA_DIR: tempDir,
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
    expect(rendered).toContain('1. npm run bootstrap');
    expect(rendered).toContain('2. npm run -s cli -- init');
    expect(rendered).toContain('POST /api/search');
    expect(rendered).toContain('memphis_search');
    expect(rendered).toContain('Feature flags: stable surface only');
    expect(rendered).toContain('Installed skills: none installed');
    expect(rendered).toContain('memphis skills list');
    expect(rendered).toContain('Rust TUI is the authoritative operator cockpit');
    expect(rendered).toContain('Telegram baseline companion policy: tier=2');
    expect(rendered).toContain('Telegram effective policy in this runtime: tier=2');

    const telegramGuide = renderSurfaceDesignGuideText('telegram', {
      MEMPHIS_DATA_DIR: tempDir,
      MEMPHIS_AGENT_NAME: 'Jawor',
      MEMPHIS_OWNER_NAME: 'Marcin',
      MEMPHIS_API_TOKEN: 'token',
      MEMPHIS_VAULT_PEPPER: 'memphis-super-secure-pepper',
    });
    expect(telegramGuide).toContain('Telegram companion guide');
    expect(telegramGuide).toContain('Baseline Telegram policy: tier=2');
    expect(telegramGuide).toContain('Effective Telegram policy in this runtime: tier=2');
    expect(telegramGuide).toContain('Rust TUI');
  });

  it('reflects preview tool exposure from the provided env, not only process.env', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'memphis-guide-preview-'));
    const guide = buildOperatorGuide({
      MEMPHIS_DATA_DIR: tempDir,
      MEMPHIS_FEATURES: 'experimental-tools',
      RUST_CHAIN_ENABLED: 'false',
    });

    const toolsSection = guide.sections.find((section) => section.title === 'Tools');
    expect(toolsSection?.lines.join('\n')).toContain('memphis_chain_query');
    expect(toolsSection?.lines.join('\n')).toContain('Feature flags: experimental-tools');
  });
});
