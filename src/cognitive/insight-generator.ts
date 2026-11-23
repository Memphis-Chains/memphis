import { ConnectionDiscovery } from './connection-discovery.js';
import { KnowledgeSynthesizer } from './knowledge-synthesizer.js';
import type { ModelEInsight } from './model-e-types.js';
import { ChainStore, IStore } from './store.js';
import { normalizeChainName } from '../config/paths.js';
import type { Block } from '../memory/chain.js';

export interface InsightReport {
  generated: Date;
  insights: ModelEInsight[];
  quickWins: string[];
  mood: 'productive' | 'exploring' | 'reflective' | 'struggling';
  summary: string;
}

/**
 * The evidence an insight keeps: a REFERENCE to the block it came from,
 * not a copy of the block.
 *
 * ## Why
 *
 * `ModelEInsight.evidence` is `Block[]` — the complete source block, with
 * its complete `data.content`. The `insights` chain stored those insights
 * verbatim, so every generated insight carried up to five full copies of
 * blocks that already live, in full, in their own chains. The chain grew
 * without bound because every run copied its sources into itself.
 *
 * Measured on the operator's host: the `insights` chain held 33.4 MB
 * across 402 blocks. 13.2 MB of that was `evidence[].data`, and another
 * 14.1 MB was the block-level `content` string — which the chain adapter
 * builds by serialising the whole payload, so the duplicated evidence was
 * stored twice over.
 *
 * A reference is enough: the block is still there, in the chain it came
 * from, under the hash it was written with.
 */
export interface InsightEvidenceReference {
  chain: string;
  index: number;
  hash: string;
  prev_hash: string;
  timestamp: string;
  title: string;
}

/** How much of a source block's text a reference keeps. */
const EVIDENCE_TITLE_LIMIT = 120;

function evidenceTitle(block: Block): string {
  const data = (block.data ?? {}) as Record<string, unknown>;
  const title = typeof data.title === 'string' ? data.title.trim() : '';
  if (title) return title.slice(0, EVIDENCE_TITLE_LIMIT);
  const content = typeof data.content === 'string' ? data.content : '';
  const firstLine = content.split('\n')[0] ?? '';
  return firstLine.slice(0, EVIDENCE_TITLE_LIMIT);
}

/**
 * The digest the chain stores as the block's `content`.
 *
 * ## Why the payload has to carry its own content
 *
 * The chain adapter (`normalizeBlockData` in
 * `src/infra/storage/chain-adapter.ts`) fills a missing `content` with
 * `JSON.stringify(data)` — the whole payload, serialised. A payload with no
 * content of its own is therefore stored TWICE: once as structured fields,
 * once as a copy of itself inside a string.
 *
 * That rule cannot change. The canonical hash of every content-less block
 * already on disk was computed over that copy, in four places that agree
 * (`chain-adapter.ts`, `core/chain-hash.ts`, `sync/sync-manager.ts` and
 * `crates/memphis-core/src/hash.rs`), so a different fallback would
 * invalidate every block that has no content of its own.
 *
 * Measured 2026-11-23 on this host: all 404 blocks of the `insights` chain
 * carried that copy — 13.67 MB of the chain's 31.92 MB, 43 % of it, written
 * again on every run. The `insights` payload is the one chain payload with
 * no content of its own, so it is the one that pays for the rule.
 *
 * The digest is what the content is FOR: the text a reader and a search
 * index see. One line per insight — its title and its description — is
 * that text. The structured payload keeps everything.
 */
const INSIGHT_SUMMARY_LIMIT = 4000;

/**
 * The readable digest of a set of insights.
 *
 * Never empty: the native write path rejects a block whose content is an
 * empty string (`chain_append rejected block: content must not be empty`),
 * so a window that produced no insights still has to say so.
 */
export function toInsightSummary(insights: ModelEInsight[], window = 'insights'): string {
  const lines: string[] = [];
  let used = 0;

  for (const insight of insights) {
    const title = insight.title.trim();
    const description = insight.description.trim();
    const line = description ? `${title}: ${description}` : title;
    if (!line) continue;
    if (used + line.length + 1 > INSIGHT_SUMMARY_LIMIT) break;
    lines.push(line);
    used += line.length + 1;
  }

  return [`${window} insights (${String(insights.length)})`, ...lines].join('\n');
}

/**
 * Reduce one source block to the reference that identifies it.
 */
export function toEvidenceReference(block: Block): InsightEvidenceReference {
  return {
    chain: block.chain ?? 'journal',
    index: block.index ?? 0,
    hash: block.hash ?? '',
    prev_hash: block.prev_hash ?? '',
    timestamp: block.timestamp ?? '',
    title: evidenceTitle(block),
  };
}

export class InsightGenerator {
  private readonly synthesizer: KnowledgeSynthesizer;
  private readonly discovery: ConnectionDiscovery;
  private readonly store: IStore;

  constructor(
    private readonly blocks: Block[],
    store: IStore = new ChainStore(),
  ) {
    const normalizedBlocks = blocks.map((block) => ({
      ...block,
      chain: normalizeChainName(block.chain ?? 'journal') ?? 'journal',
    }));
    this.blocks = normalizedBlocks;
    this.synthesizer = new KnowledgeSynthesizer(normalizedBlocks);
    this.discovery = new ConnectionDiscovery(normalizedBlocks);
    this.store = store;
  }

  /**
   * Generates and persists insights for the last 24 hours of activity.
   */
  async generateDailyInsights(): Promise<ModelEInsight[]> {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const insights = await this.generateForWindow(since, ['journal', 'decisions']);
    await this.persistInsights('daily', insights);
    return insights;
  }

  /**
   * Generates and persists insights for the last 7 days of activity.
   */
  async generateWeeklyInsights(): Promise<ModelEInsight[]> {
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const insights = await this.generateForWindow(since, ['journal', 'decisions', 'reflections']);
    await this.persistInsights('weekly', insights);
    return insights;
  }

  /**
   * Generates and persists insights centered on a specific topic.
   */
  async generateTopicInsights(topic: string): Promise<ModelEInsight[]> {
    const connected = await this.synthesizer.findConnections(topic, 'decisions');
    const insights: ModelEInsight[] = connected.map((c) => ({
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
  /**
   * Builds the assistant-facing insight report used by proactive features.
   */
  async generate(): Promise<InsightReport> {
    const insights = await this.generateDailyInsights();
    const quickWins = insights
      .filter((i) => i.actionable)
      .flatMap((i) => i.actions ?? [])
      .slice(0, 4);
    const mood = this.detectMood(insights);
    return {
      generated: new Date(),
      insights,
      quickWins,
      mood,
      summary: `${insights.length} insight(s) generated; mood=${mood}`,
    };
  }

  /**
   * Formats an insight report into a human-readable summary.
   */
  format(report: InsightReport): string {
    const lines = [
      `🧠 Memphis Insights (${report.generated.toISOString()})`,
      `Mood: ${report.mood}`,
      report.summary,
      '',
    ];
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

  private async generateForWindow(sinceTs: number, chains: string[]): Promise<ModelEInsight[]> {
    const selected = this.blocks.filter((b) => {
      const ts = new Date(b.timestamp ?? 0).getTime();
      return ts >= sinceTs;
    });

    const synthesized = await this.synthesizer.synthesizeInsights(chains);
    const bridges = await this.discovery.findBridgeTopics();

    const bridgeInsights: ModelEInsight[] = bridges.slice(0, 2).map((t) => ({
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
    insights: ModelEInsight[],
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    // The stored form keeps a REFERENCE to each evidence block, not the
    // block. The report the caller receives still carries the full
    // evidence — only the persisted copy is slimmed.
    //
    // `evidenceFormat` says which shape is on disk, so a reader never has
    // to guess whether `evidence[].data` is there.
    // `content` is the block's readable text. It is set here, by the
    // payload, so the chain adapter does not fill it with a copy of the
    // whole payload — see `toInsightSummary`.
    await this.store.append('insights', {
      type: 'insight',
      source: 'insight-generator',
      window,
      count: insights.length,
      evidenceFormat: 'reference',
      content: toInsightSummary(insights, window),
      insights: insights.map((insight) => ({
        ...insight,
        evidence: insight.evidence.map(toEvidenceReference),
      })),
      metadata,
      timestamp: new Date().toISOString(),
      tags: ['insight-generator', 'insights', window],
    });
  }

  private detectMood(insights: ModelEInsight[]): InsightReport['mood'] {
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
