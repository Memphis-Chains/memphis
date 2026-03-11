/**
 * Model E — Meta-Cognitive Reflection
 * 
 * System reflects on its own historical outputs,
 * contradictions, and blind spots.
 * 
 * @version 5.0.0
 * @adapted from Memphis v3.8.2
 */

import type { Block } from '../memory/chain.js';
import type { 
  Reflection, 
  ReflectionStats, 
  Insight, 
  Contradiction,
  ModelEConfig 
} from './types.js';
import { ChainStore, type IStore } from './store.js';

type ReflectionBlock = Block & {
  timestamp: string;
  chain: string;
  hash: string;
  data: {
    type: string;
    content?: string;
    tags?: string[];
    [key: string]: unknown;
  };
};

// ============================================================================
// REFLECTION ENGINE (MODEL E)
// ============================================================================

export class ModelE_MetaCognitiveReflection {
  private blocks: Block[];
  private config: ModelEConfig;
  private readonly store: IStore;

  constructor(
    blocks: Block[],
    config?: Partial<ModelEConfig>,
    store: IStore = new ChainStore(),
  ) {
    this.blocks = blocks;
    this.store = store;
    this.config = {
      reflectionSchedule: config?.reflectionSchedule || 'both',
      deepAnalysisDay: config?.deepAnalysisDay || 0, // Sunday
      contradictionDetection: config?.contradictionDetection ?? true,
      blindSpotAnalysis: config?.blindSpotAnalysis ?? true,
    };
  }

  private normalizeBlocks(blocks: Block[]): ReflectionBlock[] {
    return blocks.flatMap((block) => {
      const { data, timestamp, chain } = block;
      if (!data || !timestamp || !chain || typeof data.type !== 'string') {
        return [];
      }

      return [{
        ...block,
        timestamp,
        chain,
        hash: block.hash ?? `${chain}:${timestamp}`,
        data: {
          ...data,
          type: data.type,
          content: typeof data.content === 'string' ? data.content : '',
          tags: Array.isArray(data.tags) ? data.tags : [],
        },
      }];
    });
  }

  /**
   * Generate daily reflection
   */
  daily(): Reflection {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentBlocks = this.normalizeBlocks(this.blocks).filter((b) => new Date(b.timestamp) >= since);

    const reflection = this.generateReflection('daily', recentBlocks);
    void this.persistReflection(reflection);
    return reflection;
  }

  /**
   * Generate weekly reflection
   */
  weekly(): Reflection {
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentBlocks = this.normalizeBlocks(this.blocks).filter((b) => new Date(b.timestamp) >= since);

    const reflection = this.generateReflection('weekly', recentBlocks);
    void this.persistReflection(reflection);
    return reflection;
  }

  /**
   * Generate deep reflection (monthly)
   */
  deep(): Reflection {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentBlocks = this.normalizeBlocks(this.blocks).filter((b) => new Date(b.timestamp) >= since);

    const reflection = this.generateReflection('deep', recentBlocks);
    void this.persistReflection(reflection);
    return reflection;
  }

  /**
   * Generate reflection for given period
   */
  private generateReflection(
    period: 'daily' | 'weekly' | 'deep', 
    blocks: ReflectionBlock[]
  ): Reflection {
    const stats = this.calculateStats(blocks);
    const insights = this.extractInsights(blocks);
    const themes = this.extractThemes(blocks);
    const contradictions = this.config.contradictionDetection 
      ? this.detectContradictions(blocks) 
      : [];
    const blindSpots = this.config.blindSpotAnalysis 
      ? this.detectBlindSpots(blocks) 
      : [];
    const recommendations = this.generateRecommendations(insights, contradictions, blindSpots);

    return {
      period,
      stats,
      insights,
      themes,
      contradictions,
      blindSpots,
      recommendations,
      timestamp: new Date(),
    };
  }

  /**
   * Calculate reflection statistics
   */
  private calculateStats(blocks: ReflectionBlock[]): ReflectionStats {
    const now = new Date();
    const periodDays = blocks.length > 0 
      ? Math.max(1, (now.getTime() - new Date(blocks[0].timestamp).getTime()) / (1000 * 60 * 60 * 24))
      : 1;

    // Tag frequency
    const tagCounts = new Map<string, number>();
    for (const block of blocks) {
      for (const tag of block.data.tags || []) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
    const topTags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([tag, count]) => ({ tag, count }));

    // Chain frequency
    const chainCounts = new Map<string, number>();
    for (const block of blocks) {
      chainCounts.set(block.chain, (chainCounts.get(block.chain) || 0) + 1);
    }
    const topChains = Array.from(chainCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([chain, count]) => ({ chain, count }));

    // Time distribution
    let morning = 0;   // 6-12
    let afternoon = 0; // 12-18
    let evening = 0;   // 18-24
    let night = 0;     // 0-6
    
    for (const block of blocks) {
      const hour = new Date(block.timestamp).getHours();
      if (hour >= 6 && hour < 12) morning++;
      else if (hour >= 12 && hour < 18) afternoon++;
      else if (hour >= 18 && hour < 24) evening++;
      else night++;
    }

    // Average entry length
    const totalLength = blocks.reduce((sum, b) => sum + (b.data.content?.length || 0), 0);
    const averageEntryLength = blocks.length > 0 ? totalLength / blocks.length : 0;

    // Questions and decisions
    const questionsAsked = blocks.filter(b => b.data.type === 'ask').length;
    const decisionsRecorded = blocks.filter(b => b.data.type === 'decision').length;

    return {
      totalEntries: blocks.length,
      entriesPerDay: blocks.length / periodDays,
      topTags,
      topChains,
      timeDistribution: { morning, afternoon, evening, night },
      averageEntryLength,
      questionsAsked,
      decisionsRecorded,
    };
  }

  /**
   * Extract insights from blocks
   */
  private extractInsights(blocks: ReflectionBlock[]): Insight[] {
    const insights: Insight[] = [];

    // Pattern: High activity periods
    const hourCounts = new Map<number, number>();
    for (const block of blocks) {
      const hour = new Date(block.timestamp).getHours();
      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
    }
    const peakHours = Array.from(hourCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    
    if (peakHours.length > 0 && peakHours[0][1] >= 3) {
      const hours = peakHours.map(([h, _]) => `${h}:00`).join(', ');
      insights.push({
        type: 'pattern',
        title: 'Peak productivity hours',
        description: `Most active during ${hours}`,
        confidence: 0.8,
        evidence: [`${peakHours[0][1]} entries at ${peakHours[0][0]}:00`],
        actionable: true,
        suggestedAction: `Schedule important work around ${peakHours[0][0]}:00`,
      });
    }

    // Trend: Increasing/decreasing activity
    if (blocks.length >= 7) {
      const recent = blocks.slice(-3).length;
      const earlier = blocks.slice(-7, -4).length;
      
      if (recent > earlier * 1.3) {
        insights.push({
          type: 'trend',
          title: 'Increasing activity',
          description: 'Journaling frequency is increasing',
          confidence: 0.7,
          evidence: [`${recent} recent entries vs ${earlier} earlier`],
          actionable: false,
        });
      } else if (recent < earlier * 0.7) {
        insights.push({
          type: 'trend',
          title: 'Decreasing activity',
          description: 'Journaling frequency is decreasing',
          confidence: 0.7,
          evidence: [`${recent} recent entries vs ${earlier} earlier`],
          actionable: true,
          suggestedAction: 'Consider setting a daily journaling reminder',
        });
      }
    }

    // Anomaly: Unusual tags
    const tagCounts = new Map<string, number>();
    for (const block of blocks) {
      for (const tag of block.data.tags || []) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
    
    const rareTags = Array.from(tagCounts.entries())
      .filter(([_, count]) => count === 1)
      .slice(0, 5);
    
    if (rareTags.length > 0) {
      insights.push({
        type: 'anomaly',
        title: 'Unique topics',
        description: `Encountered ${rareTags.length} topics not seen before`,
        confidence: 0.6,
        evidence: rareTags.map(([tag, _]) => tag),
        actionable: false,
      });
    }

    // Opportunity: Decision backlog
    const decisions = blocks.filter(b => b.data.type === 'decision');
    if (decisions.length === 0 && blocks.length >= 5) {
      insights.push({
        type: 'opportunity',
        title: 'No decisions recorded',
        description: 'Consider recording key decisions for better tracking',
        confidence: 0.8,
        evidence: [`${blocks.length} entries without decision tracking`],
        actionable: true,
        suggestedAction: 'Use `memphis decide` to record important choices',
      });
    }

    return insights;
  }

  /**
   * Extract main themes
   */
  private extractThemes(blocks: ReflectionBlock[]): string[] {
    const wordCounts = new Map<string, number>();
    const stopWords = new Set([
      'about', 'after', 'been', 'being', 'could', 'doing', 'would', 'should',
      'their', 'there', 'these', 'those', 'through', 'under', 'until', 'where',
      'which', 'while', 'with', 'your', 'have', 'this', 'that', 'from', 'they',
      'will', 'what', 'when', 'been', 'some', 'them', 'into', 'than', 'then'
    ]);

    for (const block of blocks) {
      const words = (block.data.content || '')
        .toLowerCase()
        .split(/\W+/)
        .filter(word => word.length > 4 && !stopWords.has(word));
      
      for (const word of words) {
        wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
      }
    }

    return Array.from(wordCounts.entries())
      .filter(([_, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word, _]) => word);
  }

  /**
   * Detect contradictions
   */
  private detectContradictions(blocks: ReflectionBlock[]): Contradiction[] {
    const contradictions: Contradiction[] = [];

    // Simple temporal contradiction detection
    // (Enhanced version would use semantic analysis)
    
    const decisions = blocks.filter(b => b.data.type === 'decision');
    
    for (let i = 0; i < decisions.length; i++) {
      const left = decisions[i];
      if (!left) continue;

      for (let j = i + 1; j < decisions.length; j++) {
        const right = decisions[j];
        if (!right) continue;

        const d1 = left.data;
        const d2 = right.data;

        // Check for conflicting tags
        const conflictingTags: Array<[string, string]> = [
          ['adopt', 'reject'],
          ['yes', 'no'],
          ['build', 'skip'],
          ['priority-high', 'priority-low'],
        ];

        for (const [tag1, tag2] of conflictingTags) {
          if (d1.tags?.includes(tag1) && d2.tags?.includes(tag2)) {
            contradictions.push({
              id: `contradiction-${i}-${j}`,
              type: 'logical',
              description: `Potential conflict: "${tag1}" vs "${tag2}"`,
              block1: left.hash,
              block2: right.hash,
              severity: 'medium',
            });
          }
        }
      }
    }

    return contradictions;
  }

  /**
   * Detect blind spots
   */
  private detectBlindSpots(blocks: ReflectionBlock[]): string[] {
    const blindSpots: string[] = [];
    
    // Check for missing reflection types
    const types = new Set(blocks.map(b => b.data.type));
    
    if (!types.has('decision')) {
      blindSpots.push('No decisions recorded in this period');
    }
    if (!types.has('ask')) {
      blindSpots.push('No questions asked - consider exploring new topics');
    }
    
    // Check for missing tags
    const expectedTags = ['project', 'learning', 'idea', 'blocker', 'success'];
    const presentTags = new Set(
      blocks.flatMap(b => b.data.tags || [])
    );
    
    for (const expected of expectedTags) {
      if (!presentTags.has(expected)) {
        blindSpots.push(`No entries tagged "${expected}"`);
      }
    }

    return blindSpots;
  }

  /**
   * Generate recommendations
   */
  private generateRecommendations(
    insights: Insight[],
    contradictions: Contradiction[],
    blindSpots: string[]
  ): string[] {
    const recommendations: string[] = [];

    // From actionable insights
    for (const insight of insights) {
      if (insight.actionable && insight.suggestedAction) {
        recommendations.push(insight.suggestedAction);
      }
    }

    // From contradictions
    if (contradictions.length > 0) {
      recommendations.push(`Review ${contradictions.length} potential contradiction(s)`);
    }

    // From blind spots
    if (blindSpots.length > 2) {
      recommendations.push('Diversify journaling topics to capture more context');
    }

    return [...new Set(recommendations)].slice(0, 5);
  }

  private async persistReflection(reflection: Reflection): Promise<void> {
    await this.store.append('reflections', {
      type: 'reflection',
      source: 'model-e',
      period: reflection.period,
      stats: reflection.stats,
      insights: reflection.insights,
      themes: reflection.themes,
      contradictions: reflection.contradictions,
      blindSpots: reflection.blindSpots,
      recommendations: reflection.recommendations,
      timestamp: reflection.timestamp.toISOString(),
      tags: ['model-e', 'reflection', reflection.period],
    });
  }

  /**
   * Format reflection for display
   */
  format(reflection: Reflection): string {
    const lines: string[] = [];
    const periodEmoji = { daily: '🌅', weekly: '📅', deep: '🔍' };
    const periodName = { daily: 'DAILY', weekly: 'WEEKLY', deep: 'DEEP' };

    lines.push(`${periodEmoji[reflection.period]} Memphis Reflection — ${periodName[reflection.period]}`);
    lines.push('');
    
    // Stats
    lines.push('📊 Stats');
    lines.push(`  Journal entries: ${reflection.stats.totalEntries}`);
    lines.push(`  Entries/day: ${reflection.stats.entriesPerDay.toFixed(1)}`);
    lines.push(`  Questions asked: ${reflection.stats.questionsAsked}`);
    lines.push(`  Decisions recorded: ${reflection.stats.decisionsRecorded}`);
    
    if (reflection.stats.topTags.length > 0) {
      lines.push(`  Top tags: ${reflection.stats.topTags.slice(0, 5).map(t => t.tag).join(', ')}`);
    }
    lines.push('');

    // Insights
    if (reflection.insights.length > 0) {
      lines.push('💡 Insights');
      for (const insight of reflection.insights.slice(0, 5)) {
        const icon = { pattern: '🎯', trend: '📈', anomaly: '⚠️', opportunity: '🌟', risk: '🚨' };
        lines.push(`  ${icon[insight.type]} ${insight.title}: ${insight.description}`);
      }
      lines.push('');
    }

    // Contradictions
    if (reflection.contradictions.length > 0) {
      lines.push('⚡ Contradictions');
      for (const c of reflection.contradictions.slice(0, 3)) {
        lines.push(`  • ${c.description}`);
      }
      lines.push('');
    }

    // Blind spots
    if (reflection.blindSpots.length > 0) {
      lines.push('🔍 Blind Spots');
      for (const spot of reflection.blindSpots.slice(0, 5)) {
        lines.push(`  • ${spot}`);
      }
      lines.push('');
    }

    // Recommendations
    if (reflection.recommendations.length > 0) {
      lines.push('✨ Recommendations');
      for (const rec of reflection.recommendations) {
        lines.push(`  → ${rec}`);
      }
    }

    return lines.join('\n');
  }
}
