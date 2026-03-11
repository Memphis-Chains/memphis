/**
 * Memphis Insight Generator
 * 
 * Combines all cognitive models (A+B+C+D+E) to generate
 * actionable insights from memory chains.
 * 
 * @version 5.0.0
 */

import type { Block } from '../memory/chain.js';
import type { Insight, Reflection, Prediction } from './types.js';
import { ModelC_PredictivePatterns } from './model-c.js';
import { ModelE_MetaCognitiveReflection } from './model-e.js';

export interface InsightReport {
  generated: Date;
  summary: string;
  predictions: Prediction[];
  insights: Insight[];
  reflection: Reflection;
  quickWins: string[];
  focusAreas: string[];
  mood: 'productive' | 'exploring' | 'reflective' | 'struggling';
  nextActions: string[];
}

export class InsightGenerator {
  private blocks: Block[];
  private modelC: ModelC_PredictivePatterns;
  private modelE: ModelE_MetaCognitiveReflection;

  constructor(blocks: Block[]) {
    this.blocks = blocks;
    this.modelC = new ModelC_PredictivePatterns(blocks);
    this.modelE = new ModelE_MetaCognitiveReflection(blocks);
  }

  /**
   * Generate comprehensive insight report
   */
  async generate(): Promise<InsightReport> {
    console.log('🧠 Generating Memphis Insight Report...');
    
    // Learn patterns from history
    await this.modelC.learn();
    
    // Generate predictions
    const context = this.extractCurrentContext();
    const predictions = this.modelC.predict(context);
    console.log(`  ✨ Generated ${predictions.length} predictions`);
    
    // Generate reflection
    const reflection = this.blocks.length > 50 
      ? this.modelE.weekly() 
      : this.modelE.daily();
    console.log(`  📊 Reflection: ${reflection.stats.totalEntries} entries analyzed`);
    
    // Combine insights
    const insights = this.combineInsights(predictions, reflection);
    
    // Determine mood
    const mood = this.determineMood(reflection);
    
    // Generate quick wins
    const quickWins = this.identifyQuickWins(insights);
    
    // Identify focus areas
    const focusAreas = this.identifyFocusAreas(reflection);
    
    // Generate next actions
    const nextActions = this.generateNextActions(predictions, insights, quickWins);
    
    // Create summary
    const summary = this.createSummary(predictions, insights, mood);

    return {
      generated: new Date(),
      summary,
      predictions,
      insights,
      reflection,
      quickWins,
      focusAreas,
      mood,
      nextActions,
    };
  }

  /**
   * Extract current context
   */
  private extractCurrentContext() {
    const now = new Date();
    const recentBlocks = this.blocks.slice(-20);
    const recentTags = [...new Set(recentBlocks.flatMap(b => b.data.tags || []))];
    
    return {
      timeOfDay: now.getHours(),
      dayOfWeek: now.getDay(),
      tags: recentTags.slice(0, 5),
      recentDecisions: recentBlocks.filter(b => b.data.type === 'decision').length,
    };
  }

  /**
   * Combine insights from predictions and reflection
   */
  private combineInsights(predictions: Prediction[], reflection: Reflection): Insight[] {
    const insights: Insight[] = [];

    // Convert predictions to insights
    for (const pred of predictions.slice(0, 5)) {
      insights.push({
        type: 'pattern',
        title: pred.title,
        description: pred.reasoning || `Based on ${pred.basedOn.length} historical patterns`,
        confidence: pred.confidence,
        evidence: pred.evidence,
        actionable: true,
        suggestedAction: pred.suggestedAction,
      });
    }

    // Add reflection insights
    insights.push(...reflection.insights);

    // Sort by confidence
    insights.sort((a, b) => b.confidence - a.confidence);

    return insights.slice(0, 10);
  }

  /**
   * Determine overall mood
   */
  private determineMood(reflection: Reflection): 'productive' | 'exploring' | 'reflective' | 'struggling' {
    const stats = reflection.stats;
    
    // Productive: high activity, decisions recorded
    if (stats.entriesPerDay > 3 && stats.decisionsRecorded > 2) {
      return 'productive';
    }
    
    // Exploring: many questions, diverse tags
    if (stats.questionsAsked > 3 && stats.topTags.length > 5) {
      return 'exploring';
    }
    
    // Reflective: consistent activity, moderate decisions
    if (stats.entriesPerDay > 1 && stats.decisionsRecorded > 0) {
      return 'reflective';
    }
    
    // Struggling: low activity
    return 'struggling';
  }

  /**
   * Identify quick wins
   */
  private identifyQuickWins(insights: Insight[]): string[] {
    const quickWins: string[] = [];

    for (const insight of insights) {
      if (insight.actionable && insight.confidence > 0.7) {
        quickWins.push(insight.suggestedAction || insight.title);
      }
    }

    return [...new Set(quickWins)].slice(0, 5);
  }

  /**
   * Identify focus areas
   */
  private identifyFocusAreas(reflection: Reflection): string[] {
    const areas: string[] = [];

    // From top tags
    for (const { tag, count } of reflection.stats.topTags.slice(0, 3)) {
      if (count >= 3) {
        areas.push(`Continue work on ${tag}`);
      }
    }

    // From blind spots
    for (const spot of reflection.blindSpots.slice(0, 2)) {
      areas.push(`Address: ${spot}`);
    }

    return areas.slice(0, 5);
  }

  /**
   * Generate next actions
   */
  private generateNextActions(
    predictions: Prediction[], 
    insights: Insight[], 
    quickWins: string[]
  ): string[] {
    const actions: string[] = [];

    // From top predictions
    if (predictions.length > 0 && predictions[0].confidence > 0.75) {
      actions.push(predictions[0].suggestedAction || `Consider: ${predictions[0].title}`);
    }

    // From quick wins
    actions.push(...quickWins.slice(0, 2));

    // Default actions
    if (actions.length === 0) {
      actions.push('Record a decision about your current work');
      actions.push('Ask a question about something you\'re curious about');
    }

    return [...new Set(actions)].slice(0, 5);
  }

  /**
   * Create summary
   */
  private createSummary(predictions: Prediction[], insights: Insight[], mood: string): string {
    const moodEmoji = {
      productive: '🔥',
      exploring: '🔍',
      reflective: '💭',
      struggling: '💪',
    };

    const parts: string[] = [];
    
    parts.push(`${moodEmoji[mood]} You're in a ${mood} phase.`);
    
    if (predictions.length > 0) {
      parts.push(`Top prediction: ${predictions[0].title} (${(predictions[0].confidence * 100).toFixed(0)}% confidence).`);
    }
    
    if (insights.length > 0) {
      parts.push(`${insights.length} insights available.`);
    }

    return parts.join(' ');
  }

  /**
   * Format report for display
   */
  format(report: InsightReport): string {
    const lines: string[] = [];

    // Header
    lines.push('╔══════════════════════════════════════════╗');
    lines.push('║      🧠 MEMPHIS INSIGHT REPORT           ║');
    lines.push('╚══════════════════════════════════════════╝');
    lines.push('');

    // Summary
    lines.push(`📝 ${report.summary}`);
    lines.push('');

    // Mood
    const moodEmoji = { productive: '🔥', exploring: '🔍', reflective: '💭', struggling: '💪' };
    lines.push(`Mood: ${moodEmoji[report.mood]} ${report.mood.charAt(0).toUpperCase() + report.mood.slice(1)}`);
    lines.push('');

    // Predictions
    if (report.predictions.length > 0) {
      lines.push('🔮 Top Predictions');
      for (let i = 0; i < Math.min(3, report.predictions.length); i++) {
        const pred = report.predictions[i];
        lines.push(`  ${(pred.confidence * 100).toFixed(0)}% ${pred.title}`);
      }
      lines.push('');
    }

    // Quick Wins
    if (report.quickWins.length > 0) {
      lines.push('⚡ Quick Wins');
      for (const win of report.quickWins) {
        lines.push(`  → ${win}`);
      }
      lines.push('');
    }

    // Focus Areas
    if (report.focusAreas.length > 0) {
      lines.push('🎯 Focus Areas');
      for (const area of report.focusAreas) {
        lines.push(`  • ${area}`);
      }
      lines.push('');
    }

    // Next Actions
    if (report.nextActions.length > 0) {
      lines.push('✨ Next Actions');
      for (let i = 0; i < report.nextActions.length; i++) {
        lines.push(`  ${i + 1}. ${report.nextActions[i]}`);
      }
      lines.push('');
    }

    // Stats
    lines.push('📊 Stats');
    lines.push(`  Entries analyzed: ${report.reflection.stats.totalEntries}`);
    lines.push(`  Insights generated: ${report.insights.length}`);
    lines.push(`  Patterns learned: ${report.reflection.stats.topTags.length} themes`);
    lines.push('');
    lines.push(`Generated: ${report.generated.toISOString()}`);

    return lines.join('\n');
  }
}

/**
 * Quick insight generation (for CLI)
 */
export async function quickInsight(blocks: Block[]): Promise<string> {
  const generator = new InsightGenerator(blocks);
  const report = await generator.generate();
  return generator.format(report);
}
