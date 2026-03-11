import type { Block } from '../memory/chain.js';
import type { Insight } from './model-e-types.js';
import { KnowledgeSynthesizer } from './knowledge-synthesizer.js';
import { ConnectionDiscovery } from './connection-discovery.js';
import { ChainStore, type IStore } from './store.js';

export interface InsightReport {
  generated: Date;
  insights: Insight[];
  quickWins: string[];
  mood: 'productive' | 'exploring' | 'reflective' | 'struggling';
  summary: string;
}

export class InsightGenerator {
  private readonly synthesizer: KnowledgeSynthesizer;
  private readonly discovery: ConnectionDiscovery;
  private readonly store: IStore;

  constructor(private readonly blocks: Block[], store: IStore = new ChainStore()) {
    this.synthesizer = new KnowledgeSynthesizer(blocks);
    this.discovery = new ConnectionDiscovery(blocks);
    this.store = store;
  }

  async generateDailyInsights(): Promise<Insight[]> {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const insights = await this.generateForWindow(since, ['journal', 'decision']);
    await this.persistInsights('daily', insights);
    return insights;
  }

  async generateWeeklyInsights(): Promise<Insight[]> {
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const insights = await this.generateForWindow(since, ['journal', 'decision', 'reflection']);
    await this.persistInsights('weekly', insights);
    return insights;
  }

  async generateTopicInsights(topic: string): Promise<Insight[]> {
    const connected = await this.synthesizer.findConnections(topic, 'decision');
    const insights: Insight[] = connected.map((c) => ({
      type: c.novelty > 0.65 ? 'prediction' : 'pattern',
      title: `Topic insight: ${topic}`,
      description: c.description,
      confidence: Math.min(0.95, (c.strength + (1 - c.novelty)) / 1.5),
      evidence: c.evidence,
      actionable: true,
      actions: [`Review evidence for ${topic}`, `Create one next-step decision for ${topic}`],
    }));
    await this.persistInsights('topic', insights, { topic });
    return insights;
  }

  // backward-compatible report API for proactive assistant
  async generate(): Promise<InsightReport> {
    const insights = await this.generateDailyInsights();
    const quickWins = insights.filter((i) => i.actionable).flatMap((i) => i.actions ?? []).slice(0, 4);
    const mood = this.detectMood(insights);
    return {
      generated: new Date(),
      insights,
      quickWins,
      mood,
      summary: `${insights.length} insight(s) generated; mood=${mood}`,
    };
  }

  format(report: InsightReport): string {
    const lines = [`🧠 Memphis Insights (${report.generated.toISOString()})`, `Mood: ${report.mood}`, report.summary, ''];
    for (const insight of report.insights.slice(0, 5)) {
      lines.push(`• [${insight.type}] ${insight.title} (${Math.round(insight.confidence * 100)}%)`);
      lines.push(`  ${insight.description}`);
    }
    if (report.quickWins.length > 0) {
      lines.push('', '⚡ Quick wins:');
      for (const win of report.quickWins) lines.push(`  - ${win}`);
    }
    return lines.join('\n');
  }

  private async generateForWindow(sinceTs: number, chains: string[]): Promise<Insight[]> {
    const selected = this.blocks.filter((b) => {
      const ts = new Date(b.timestamp ?? 0).getTime();
      return ts >= sinceTs;
    });

    const synthesized = await this.synthesizer.synthesizeInsights(chains);
    const bridges = await this.discovery.findBridgeTopics();

    const bridgeInsights: Insight[] = bridges.slice(0, 2).map((t) => ({
      type: 'recommendation',
      title: `Bridge topic: ${t.name}`,
      description: `Topic links multiple contexts (bridge score ${t.bridgeScore.toFixed(1)}).`,
      confidence: Math.min(0.9, 0.45 + t.bridgeScore / 10),
      evidence: selected.filter((b) => (b.data?.tags ?? []).includes(t.name)).slice(0, 3),
      actionable: true,
      actions: [`Sync notes for ${t.name}`, `Decide one priority for ${t.name}`],
    }));

    return [...synthesized, ...bridgeInsights].slice(0, 8);
  }

  private async persistInsights(
    window: 'daily' | 'weekly' | 'topic',
    insights: Insight[],
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.store.append('insights', {
      type: 'insight',
      source: 'insight-generator',
      window,
      count: insights.length,
      insights,
      metadata,
      timestamp: new Date().toISOString(),
      tags: ['insight-generator', 'insights', window],
    });
  }

  private detectMood(insights: Insight[]): InsightReport['mood'] {
    if (insights.length >= 5) return 'productive';
    if (insights.some((i) => i.type === 'prediction')) return 'exploring';
    if (insights.length >= 2) return 'reflective';
    return 'struggling';
  }
}

export async function quickInsight(blocks: Block[]): Promise<string> {
  const generator = new InsightGenerator(blocks);
  return generator.format(await generator.generate());
}
