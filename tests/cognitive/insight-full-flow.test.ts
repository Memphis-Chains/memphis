import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Block } from '../../src/memory/chain.js';
import { InsightGenerator } from '../../src/cognitive/insight-generator.js';
import { ModelE_MetaCognitiveReflection } from '../../src/cognitive/model-e.js';
import { ModelD_CollectiveCoordination } from '../../src/cognitive/model-d.js';

beforeAll(() => {
  (ModelD_CollectiveCoordination as unknown as { prototype: { persistEvent?: (...args: unknown[]) => Promise<void> } }).prototype.persistEvent =
    async () => {};
});

const originalHome = process.env.HOME;
const homesToCleanup: string[] = [];

afterEach(() => {
  const dir = homesToCleanup.pop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

function isolateHome(): void {
  const home = mkdtempSync(join(tmpdir(), 'insight-flow-home-'));
  homesToCleanup.push(home);
  process.env.HOME = home;
}

describe('Insight full flow', () => {
  it('creates insights from mixed journal and decision history', async () => {
    isolateHome();
    const now = Date.now();
    const blocks: Block[] = [
      { timestamp: new Date(now - 1000).toISOString(), chain: 'journal', data: { type: 'journal', content: 'AI planning around model improvements and testing strategy', tags: ['ai', 'project'] } },
      { timestamp: new Date(now - 2000).toISOString(), chain: 'journal', data: { type: 'ask', content: 'How to improve reliability of insights pipeline?', tags: ['ai', 'learning'] } },
      { timestamp: new Date(now - 3000).toISOString(), chain: 'decision', data: { type: 'decision', content: 'Adopt stricter tests for cognitive modules', tags: ['testing', 'success'] } },
      { timestamp: new Date(now - 4000).toISOString(), chain: 'journal', data: { type: 'journal', content: 'Observed trend: better coverage improves confidence', tags: ['testing', 'trend'] } },
    ];

    const generator = new InsightGenerator(blocks);
    const daily = await generator.generateDailyInsights();
    const topic = await generator.generateTopicInsights('ai');

    expect(daily.length).toBeGreaterThan(0);
    expect(topic.length).toBeGreaterThan(0);
  });

  it('turns reflection recommendations into collective proposals', () => {
    isolateHome();
    const blocks: Block[] = [
      { timestamp: new Date().toISOString(), chain: 'journal', data: { type: 'journal', content: 'misc note one', tags: ['misc'] } },
      { timestamp: new Date().toISOString(), chain: 'journal', data: { type: 'journal', content: 'misc note two', tags: ['misc'] } },
      { timestamp: new Date().toISOString(), chain: 'journal', data: { type: 'journal', content: 'misc note three', tags: ['misc'] } },
      { timestamp: new Date().toISOString(), chain: 'journal', data: { type: 'journal', content: 'misc note four', tags: ['misc'] } },
      { timestamp: new Date().toISOString(), chain: 'journal', data: { type: 'journal', content: 'misc note five', tags: ['misc'] } },
    ];

    const reflection = new ModelE_MetaCognitiveReflection(blocks).daily();

    const modelD = new ModelD_CollectiveCoordination({
      consensusThreshold: 0.6,
      votingTimeout: 30_000,
      agents: [
        { id: 'memphis', name: 'Memphis', endpoint: 'local', publicKey: 'k1', weight: 1 },
        { id: 'watra', name: 'Watra', endpoint: 'local', publicKey: 'k2', weight: 1 },
      ],
    });

    const proposal = modelD.propose(
      'Act on reflection',
      reflection.recommendations.join('; ') || 'no recommendations',
      'memphis',
      'tactical',
    );

    modelD.vote(proposal.id, 'memphis', 'approve');
    modelD.vote(proposal.id, 'watra', 'approve');

    const closed = modelD.getProposal(proposal.id);
    expect(closed?.status).toBe('approved');
  });

  it('exports approved proposal as decision block and re-ingests for insights', async () => {
    isolateHome();
    const modelD = new ModelD_CollectiveCoordination({
      consensusThreshold: 0.5,
      votingTimeout: 30_000,
      agents: [
        { id: 'a', name: 'A', endpoint: 'local', publicKey: 'k1', weight: 1 },
        { id: 'b', name: 'B', endpoint: 'local', publicKey: 'k2', weight: 1 },
      ],
    });

    const proposal = modelD.propose('Enable quality gates', 'Run all tests before release', 'a');
    modelD.vote(proposal.id, 'a', 'approve');
    modelD.vote(proposal.id, 'b', 'approve');

    const exported = modelD.toBlock(proposal.id) as Block;
    const blocks: Block[] = [
      { timestamp: new Date().toISOString(), chain: 'journal', data: { type: 'journal', content: 'quality gate note', tags: ['quality', 'project'] } },
      exported,
    ];

    const generator = new InsightGenerator(blocks);
    const insights = await generator.generateDailyInsights();

    expect(insights.length).toBeGreaterThan(0);
  });
});
