import type { Block } from '../memory/chain.js';
import type { ProactiveSuggestion } from './model-e-types.js';
import { InsightGenerator } from './insight-generator.js';

export class ProactiveSuggestionEngine {
  private readonly insightGenerator: InsightGenerator;

  constructor(private readonly blocks: Block[]) {
    this.insightGenerator = new InsightGenerator(blocks);
  }

  async generateSuggestions(): Promise<ProactiveSuggestion[]> {
    const [timeBased, base] = await Promise.all([
      this.generateTimeBased(),
      this.generateContextAware(this.recentContext()),
    ]);
    return [...timeBased, ...base].slice(0, 8);
  }

  async generateTimeBased(): Promise<ProactiveSuggestion[]> {
    const hour = new Date().getHours();
    if (hour >= 18) {
      return [{
        type: 'reflect',
        message: 'End-of-day reflection suggested: capture 1 win and 1 blocker.',
        priority: 'medium',
        dismissible: true,
      }];
    }
    if (hour < 10) {
      return [{
        type: 'decide',
        message: 'Define one concrete decision before noon to anchor focus.',
        priority: 'medium',
        dismissible: true,
      }];
    }
    return [];
  }

  async generateContextAware(context: string): Promise<ProactiveSuggestion[]> {
    const suggestions: ProactiveSuggestion[] = [];
    const report = await this.insightGenerator.generate();

    if (report.mood === 'struggling') {
      suggestions.push({
        type: 'journal',
        message: 'Momentum seems low. Write a short journal entry with the smallest next step.',
        priority: 'high',
        dismissible: false,
      });
    }

    if (context.includes('decision') === false) {
      suggestions.push({
        type: 'decide',
        message: 'No recent decision trace detected — record one explicit decision.',
        priority: 'high',
        dismissible: true,
      });
    }

    if (context.includes('sync')) {
      suggestions.push({
        type: 'sync',
        message: 'You touched sync-related topics. Consider running a cross-chain sync check.',
        priority: 'medium',
        dismissible: true,
      });
    }

    return suggestions;
  }

  private recentContext(): string {
    return this.blocks.slice(-12).map((b) => `${b.data?.type ?? ''} ${(b.data?.tags ?? []).join(' ')}`.trim()).join(' ').toLowerCase();
  }
}
