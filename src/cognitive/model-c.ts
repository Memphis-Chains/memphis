/**
 * Model C — Predictive Patterns
 * 
 * Learns decision patterns from Model A+B history
 * and generates predictive suggestions.
 * 
 * @version 5.0.0
 * @adapted from Memphis v3.8.2
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Block } from '../memory/chain.js';
import type { 
  DecisionPattern, 
  Prediction, 
  DecisionContext,
  ModelCConfig
} from './types.js';
import { ChainStore, type IStore } from './store.js';
import { getDataDir } from '../config/paths.js';

type DecisionBlock = Block & {
  timestamp: string;
  chain: string;
  data: {
    type: string;
    content: string;
    tags?: string[];
    [key: string]: unknown;
  };
};

// ============================================================================
// PATTERN STORAGE
// ============================================================================

export class PatternStorage {
  private patternsPath: string;
  private patterns: Map<string, DecisionPattern> = new Map();

  constructor(memphisDir: string = getDataDir()) {
    this.patternsPath = path.join(memphisDir, 'patterns.json');
    this.load();
  }

  /**
   * Loads persisted patterns from disk into memory.
   */
  load(): void {
    try {
      if (fs.existsSync(this.patternsPath)) {
        const data = JSON.parse(fs.readFileSync(this.patternsPath, 'utf-8'));
        this.patterns = new Map(Object.entries(data));
        console.log(`📚 Loaded ${this.patterns.size} patterns`);
      }
    } catch (error) {
      console.warn('Failed to load patterns, starting fresh:', error);
      this.patterns = new Map();
    }
  }

  /**
   * Persists the current pattern set to disk.
   */
  save(): void {
    try {
      const data = Object.fromEntries(this.patterns);
      fs.writeFileSync(this.patternsPath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Failed to save patterns:', error);
    }
  }

  /**
   * Retrieves a pattern by identifier.
   */
  get(id: string): DecisionPattern | undefined {
    return this.patterns.get(id);
  }

  /**
   * Returns all persisted patterns.
   */
  getAll(): DecisionPattern[] {
    return Array.from(this.patterns.values());
  }

  /**
   * Stores a pattern and writes the updated collection to disk.
   */
  set(pattern: DecisionPattern): void {
    this.patterns.set(pattern.id, pattern);
    this.save();
  }

  /**
   * Removes a pattern by identifier.
   */
  delete(id: string): boolean {
    const result = this.patterns.delete(id);
    if (result) {
      this.save();
    }
    return result;
  }

  /**
   * Returns the number of stored patterns.
   */
  count(): number {
    return this.patterns.size;
  }
}

// ============================================================================
// PATTERN LEARNER (MODEL C)
// ============================================================================

export class ModelC_PredictivePatterns {
  private storage: PatternStorage;
  private blocks: Block[];
  private config: ModelCConfig;
  private readonly store: IStore;

  constructor(
    blocks: Block[],
    config?: Partial<ModelCConfig>,
    store: IStore = new ChainStore(),
  ) {
    this.blocks = blocks;
    this.storage = new PatternStorage();
    this.store = store;
    this.config = {
      patternMinOccurrences: config?.patternMinOccurrences || 3,
      confidenceCap: config?.confidenceCap || 0.95,
      contextSimilarityThreshold: config?.contextSimilarityThreshold || 0.7,
      recencyBoost: config?.recencyBoost || 0.1,
      accuracyWeight: config?.accuracyWeight || 0.5,
      predictionCooldown: config?.predictionCooldown || 300000, // 5 minutes
    };
  }

  /**
   * Learn patterns from decision history
   */
  async learn(): Promise<DecisionPattern[]> {
    const decisions = this.extractDecisions();
    const newPatterns: DecisionPattern[] = [];

    console.log(`📚 Analyzing ${decisions.length} decisions...`);

    // Group decisions by similar context
    const contextGroups = this.groupBySimilarContext(decisions);
    console.log(`🔍 Found ${contextGroups.size} context groups`);

    // Create patterns from groups with enough occurrences
    for (const [contextKey, group] of contextGroups) {
      if (group.length >= this.config.patternMinOccurrences) {
        const pattern = this.createPattern(contextKey, group);
        
        // Check if pattern already exists
        const existing = this.findSimilarPattern(pattern);
        if (existing) {
          // Update existing pattern
          existing.occurrences += group.length;
          existing.lastSeen = new Date();
          existing.updated = new Date();
          this.storage.set(existing);
          await this.persistPattern(existing, 'updated');
        } else {
          // Save new pattern
          this.storage.set(pattern);
          await this.persistPattern(pattern, 'created');
          newPatterns.push(pattern);
          console.log(`  ✨ New pattern: ${pattern.prediction.title}`);
        }
      }
    }

    console.log(`✅ Created ${newPatterns.length} new patterns (total: ${this.storage.count()})`);
    return newPatterns;
  }

  /**
   * Generate prediction for current context
   */
  predict(context: DecisionContext): Prediction[] {
    const patterns = this.storage.getAll();
    const predictions: Prediction[] = [];

    for (const pattern of patterns) {
      const similarity = this.calculateContextSimilarity(context, pattern.context);
      
      if (similarity >= this.config.contextSimilarityThreshold) {
        // Calculate confidence
        let confidence = similarity;
        
        // Apply recency boost
        const daysSinceLastSeen = (Date.now() - pattern.lastSeen.getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceLastSeen < 7) {
          confidence += this.config.recencyBoost;
        }
        
        // Apply accuracy weight
        if (pattern.accuracy !== undefined) {
          confidence = confidence * (1 - this.config.accuracyWeight) + 
                      pattern.accuracy * this.config.accuracyWeight;
        }
        
        // Cap confidence
        confidence = Math.min(confidence, this.config.confidenceCap);

        predictions.push({
          type: pattern.prediction.type,
          title: pattern.prediction.title,
          confidence,
          basedOn: [pattern.id],
          evidence: pattern.prediction.evidence,
          pattern,
          suggestedAction: `Based on past behavior, you might want to ${pattern.prediction.title.toLowerCase()}`,
          reasoning: `Seen ${pattern.occurrences} times in similar context (${(similarity * 100).toFixed(0)}% match)`,
        });
      }
    }

    // Sort by confidence
    predictions.sort((a, b) => b.confidence - a.confidence);

    return predictions;
  }

  /**
   * Extract decisions from blocks
   */
  private extractDecisions(): DecisionBlock[] {
    return this.blocks.flatMap((block) => {
      const data = block.data;
      const timestamp = block.timestamp;
      const chain = block.chain;

      if (!data || !timestamp || !chain || typeof data.content !== 'string' || typeof data.type !== 'string') {
        return [];
      }

      if (data.type !== 'decision' && data.type !== 'journal') {
        return [];
      }

      return [{
        ...block,
        timestamp,
        chain,
        data: {
          ...data,
          content: data.content,
          type: data.type,
          tags: Array.isArray(data.tags) ? data.tags : [],
        },
      }];
    });
  }

  /**
   * Group decisions by similar context
   */
  private groupBySimilarContext(decisions: DecisionBlock[]): Map<string, DecisionBlock[]> {
    const groups = new Map<string, DecisionBlock[]>();

    for (const decision of decisions) {
      const context = this.extractContext(decision);
      const key = this.contextToKey(context);

      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(decision);
    }

    return groups;
  }

  /**
   * Extract context from block
   */
  private extractContext(block: DecisionBlock): DecisionContext {
    const timestamp = new Date(block.timestamp);
    
    return {
      timeOfDay: timestamp.getHours(),
      dayOfWeek: timestamp.getDay(),
      tags: block.data.tags,
      chain: block.chain,
      recentDecisions: this.countRecentDecisions(timestamp),
    };
  }

  /**
   * Count recent decisions (last 7 days)
   */
  private countRecentDecisions(since: Date): number {
    const cutoff = new Date(since.getTime() - 7 * 24 * 60 * 60 * 1000);
    return this.blocks.filter((block) => {
      if (!block.timestamp || block.data?.type !== 'decision') {
        return false;
      }

      const blockTime = new Date(block.timestamp);
      return blockTime >= cutoff && blockTime <= since;
    }).length;
  }

  /**
   * Convert context to hashable key
   */
  private contextToKey(context: DecisionContext): string {
    const parts: string[] = [];
    
    if (context.timeOfDay !== undefined) {
      parts.push(`time:${Math.floor(context.timeOfDay / 6)}`); // 4 time buckets
    }
    if (context.dayOfWeek !== undefined) {
      parts.push(`day:${context.dayOfWeek}`);
    }
    if (context.tags && context.tags.length > 0) {
      parts.push(`tags:${context.tags.slice(0, 3).sort().join(',')}`);
    }
    
    return parts.join('|');
  }

  /**
   * Create pattern from context group
   */
  private createPattern(_contextKey: string, group: DecisionBlock[]): DecisionPattern {
    const baseBlock = group[0];
    if (!baseBlock) {
      throw new Error('Cannot create a pattern from an empty decision group');
    }

    const context = this.extractContext(baseBlock);
    const commonTags = this.findCommonTags(group);
    
    // Find most common content themes
    const themes = this.extractThemes(group);
    
    return {
      id: `pattern-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      context,
      prediction: {
        type: this.classifyPatternType(context, commonTags),
        title: this.generatePatternTitle(themes, commonTags),
        confidence: Math.min(group.length / 10, this.config.confidenceCap),
        evidence: themes.slice(0, 3),
      },
      occurrences: group.length,
      lastSeen: new Date(),
      created: new Date(),
      updated: new Date(),
    };
  }

  /**
   * Find common tags in decision group
   */
  private findCommonTags(group: DecisionBlock[]): string[] {
    const tagCounts = new Map<string, number>();
    
    for (const block of group) {
      for (const tag of block.data.tags || []) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
    
    return Array.from(tagCounts.entries())
      .filter(([_, count]) => count >= group.length * 0.5) // Present in 50%+ of blocks
      .map(([tag, _]) => tag)
      .sort();
  }

  /**
   * Extract themes from decision group
   */
  private extractThemes(group: DecisionBlock[]): string[] {
    // Simple keyword extraction (can be enhanced with NLP)
    const words = group
      .map(block => block.data.content.toLowerCase())
      .join(' ')
      .split(/\W+/)
      .filter(word => word.length > 4 && !this.isStopWord(word));
    
    const wordCounts = new Map<string, number>();
    for (const word of words) {
      wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
    }
    
    return Array.from(wordCounts.entries())
      .filter(([_, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word, _]) => word);
  }

  /**
   * Check if word is stop word
   */
  private isStopWord(word: string): boolean {
    const stopWords = new Set([
      'about', 'after', 'again', 'been', 'being', 'could', 'doing', 'during',
      'would', 'should', 'their', 'there', 'these', 'those', 'through',
      'under', 'until', 'where', 'which', 'while', 'with', 'would', 'your'
    ]);
    return stopWords.has(word);
  }

  /**
   * Classify pattern type
   */
  private classifyPatternType(context: DecisionContext, tags: string[]): 'strategic' | 'tactical' | 'technical' {
    const strategicKeywords = ['roadmap', 'vision', 'milestone', 'release', 'launch'];
    const tacticalKeywords = ['sprint', 'task', 'feature', 'implement', 'build'];
    
    const allWords = [...tags, ...(context.activity || [])].join(' ').toLowerCase();
    
    if (strategicKeywords.some(kw => allWords.includes(kw))) {
      return 'strategic';
    }
    if (tacticalKeywords.some(kw => allWords.includes(kw))) {
      return 'tactical';
    }
    return 'technical';
  }

  /**
   * Generate pattern title
   */
  private generatePatternTitle(themes: string[], tags: string[]): string {
    if (themes.length === 0 && tags.length === 0) {
      return 'Working session';
    }
    
    const primaryTheme = themes[0] || tags[0];
    return `Focus on ${primaryTheme}`;
  }

  /**
   * Find similar existing pattern
   */
  private findSimilarPattern(pattern: DecisionPattern): DecisionPattern | undefined {
    const patterns = this.storage.getAll();
    
    for (const existing of patterns) {
      const similarity = this.calculateContextSimilarity(pattern.context, existing.context);
      if (similarity >= this.config.contextSimilarityThreshold) {
        return existing;
      }
    }
    
    return undefined;
  }

  /**
   * Calculate context similarity
   */
  private calculateContextSimilarity(ctx1: DecisionContext, ctx2: DecisionContext): number {
    let score = 0;
    let factors = 0;

    // Time of day similarity
    if (ctx1.timeOfDay !== undefined && ctx2.timeOfDay !== undefined) {
      const hourDiff = Math.abs(ctx1.timeOfDay - ctx2.timeOfDay);
      score += Math.max(0, 1 - hourDiff / 12);
      factors++;
    }

    // Day of week similarity
    if (ctx1.dayOfWeek !== undefined && ctx2.dayOfWeek !== undefined) {
      score += ctx1.dayOfWeek === ctx2.dayOfWeek ? 1 : 0;
      factors++;
    }

    // Tag overlap
    if (ctx1.tags && ctx2.tags) {
      const overlap = ctx1.tags.filter(tag => ctx2.tags!.includes(tag)).length;
      const total = new Set([...ctx1.tags, ...ctx2.tags]).size;
      score += overlap / total;
      factors++;
    }

    // Chain match
    if (ctx1.chain && ctx2.chain) {
      score += ctx1.chain === ctx2.chain ? 1 : 0;
      factors++;
    }

    return factors > 0 ? score / factors : 0;
  }

  private async persistPattern(pattern: DecisionPattern, event: 'created' | 'updated' | 'accuracy-update'): Promise<void> {
    await this.store.append('patterns', {
      type: 'pattern',
      source: 'model-c',
      event,
      patternId: pattern.id,
      context: pattern.context,
      prediction: pattern.prediction,
      occurrences: pattern.occurrences,
      accuracy: pattern.accuracy,
      totalPredictions: pattern.totalPredictions,
      correctPredictions: pattern.correctPredictions,
      tags: ['model-c', 'pattern', event],
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Record prediction accuracy
   */
  recordAccuracy(patternId: string, wasCorrect: boolean): void {
    const pattern = this.storage.get(patternId);
    if (pattern) {
      pattern.totalPredictions = (pattern.totalPredictions || 0) + 1;
      if (wasCorrect) {
        pattern.correctPredictions = (pattern.correctPredictions || 0) + 1;
      }
      pattern.accuracy = pattern.correctPredictions! / pattern.totalPredictions!;
      pattern.updated = new Date();
      this.storage.set(pattern);
      void this.persistPattern(pattern, 'accuracy-update');
    }
  }

  /**
   * Get statistics
   */
  getStats(): { totalPatterns: number; avgOccurrences: number; avgAccuracy: number } {
    const patterns = this.storage.getAll();
    const totalPatterns = patterns.length;
    
    const avgOccurrences = patterns.length > 0
      ? patterns.reduce((sum, p) => sum + p.occurrences, 0) / patterns.length
      : 0;
    
    const patternsWithAccuracy = patterns.filter(p => p.accuracy !== undefined);
    const avgAccuracy = patternsWithAccuracy.length > 0
      ? patternsWithAccuracy.reduce((sum, p) => sum + p.accuracy!, 0) / patternsWithAccuracy.length
      : 0;
    
    return { totalPatterns, avgOccurrences, avgAccuracy };
  }
}

export type { DecisionBlock };
