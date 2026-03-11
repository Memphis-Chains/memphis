import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ProactiveSuggestionEngine } from '../../src/cognitive/proactive-suggestions.js';
import type { Block } from '../../src/memory/chain.js';

const blocks: Block[] = [
  {
    timestamp: new Date().toISOString(),
    chain: 'journal',
    data: { type: 'journal', content: 'working on sync pipeline', tags: ['sync', 'pipeline'] },
  },
  {
    timestamp: new Date().toISOString(),
    chain: 'journal',
    data: { type: 'journal', content: 'stuck on issue', tags: ['blocker'] },
  },
];

const originalHome = process.env.HOME;
const homesToCleanup: string[] = [];

afterEach(() => {
  const dir = homesToCleanup.pop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function isolateHome(): void {
  const home = mkdtempSync(join(tmpdir(), 'proactive-home-'));
  homesToCleanup.push(home);
  process.env.HOME = home;
}

describe('ProactiveSuggestionEngine', () => {
  it('generates contextual suggestions', async () => {
    isolateHome();
    const engine = new ProactiveSuggestionEngine(blocks);
    const out = await engine.generateContextAware('sync pipeline pending next step');
    expect(out.length).toBeGreaterThan(0);
    expect(out.some((s) => s.type === 'decide')).toBe(true);
  });

  it('generates aggregate suggestions', async () => {
    isolateHome();
    const engine = new ProactiveSuggestionEngine(blocks);
    const out = await engine.generateSuggestions();
    expect(out.length).toBeGreaterThan(0);
  });
});
