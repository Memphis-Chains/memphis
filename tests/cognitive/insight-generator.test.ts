import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InsightGenerator } from '../../src/cognitive/insight-generator.js';
import type { Block } from '../../src/memory/chain.js';

const now = Date.now();
const blocks: Block[] = [
  { timestamp: new Date(now - 1000).toISOString(), chain: 'journal', data: { type: 'journal', content: 'AI notes', tags: ['ai', 'project:x'] } },
  { timestamp: new Date(now - 2000).toISOString(), chain: 'decision', data: { type: 'decision', content: 'choose stack', tags: ['ai'] } },
  { timestamp: new Date(now - 3000).toISOString(), chain: 'journal', data: { type: 'journal', content: 'sync chain', tags: ['sync'] } },
];

const originalHome = process.env.HOME;
const homesToCleanup: string[] = [];

afterEach(() => {
  const dir = homesToCleanup.pop();
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
  }
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

function isolateHome(): void {
  const home = mkdtempSync(join(tmpdir(), 'memphis-insight-home-'));
  homesToCleanup.push(home);
  process.env.HOME = home;
}

describe('InsightGenerator', () => {
  it('generates daily insights', async () => {
    isolateHome();
    const g = new InsightGenerator(blocks);
    const out = await g.generateDailyInsights();
    expect(out.length).toBeGreaterThan(0);
  });

  it('generates topic insights', async () => {
    isolateHome();
    const g = new InsightGenerator(blocks);
    const out = await g.generateTopicInsights('ai');
    expect(out.length).toBeGreaterThan(0);
    expect(out[0].title.toLowerCase()).toContain('topic insight');
  });
});
