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
import { createHash } from 'node:crypto';
import * as path from 'path';

import { appendDurableBlock } from './durable-write.js';
import { ChainStore, IStore } from './store.js';
import type { DecisionContext, DecisionPattern, ModelCConfig, Prediction } from './types.js';
import { NODE_ENV } from '../config/env-registry.js';
import { getDataDir, getReadableChainPaths } from '../config/paths.js';
import { createLogger } from '../infra/logging/logger.js';
import type { Block } from '../memory/chain.js';

const logger = createLogger('info', 'text', { component: 'ModelC' });
const seenPatternPersistenceWarnings = new Set<string>();
const seenPatternLoadWarnings = new Set<string>();

const MODEL_C_STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'been',
  'being',
  'could',
  'doing',
  'during',
  'would',
  'should',
  'their',
  'there',
  'these',
  'those',
  'through',
  'under',
  'until',
  'where',
  'which',
  'while',
  'with',
  'would',
  'your',
]);

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

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(0);
}

function hydratePattern(value: unknown): DecisionPattern | null {
  if (!value || typeof value !== 'object') return null;
  const pattern = value as DecisionPattern & {
    lastSeen?: string | number | Date;
    created?: string | number | Date;
    updated?: string | number | Date;
  };

  return {
    ...pattern,
    lastSeen: toDate(pattern.lastSeen),
    created: toDate(pattern.created),
    updated: toDate(pattern.updated),
  };
}

function serializePattern(pattern: DecisionPattern): Record<string, unknown> {
  return {
    ...pattern,
    lastSeen: pattern.lastSeen.toISOString(),
    created: pattern.created.toISOString(),
    updated: pattern.updated.toISOString(),
  };
}

function resolvePatternRuntimeDir(memphisDir?: string): string | null {
  if (typeof memphisDir === 'string' && memphisDir.trim().length > 0) {
    return path.resolve(memphisDir);
  }
  const explicit = process.env.MEMPHIS_DATA_DIR;
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return path.resolve(explicit);
  }
  if (NODE_ENV.read(process.env) === 'test') {
    return null;
  }
  return getDataDir();
}

function hydratePatternFromBlock(
  value: Record<string, unknown>,
  blockTimestamp?: string,
): DecisionPattern | null {
  const nestedPattern =
    value.pattern && typeof value.pattern === 'object' ? hydratePattern(value.pattern) : null;
  if (nestedPattern) return nestedPattern;
  if (value.kind !== 'pattern') return null;
  if (typeof value.patternId !== 'string' || value.patternId.trim().length === 0) return null;
  if (!value.context || typeof value.context !== 'object') return null;
  if (!value.prediction || typeof value.prediction !== 'object') return null;

  const fallbackTimestamp = blockTimestamp ?? new Date(0).toISOString();
  return hydratePattern({
    id: value.patternId,
    context: value.context,
    prediction: value.prediction,
    occurrences:
      typeof value.occurrences === 'number' && Number.isFinite(value.occurrences)
        ? value.occurrences
        : 0,
    accuracy:
      typeof value.accuracy === 'number' && Number.isFinite(value.accuracy)
        ? value.accuracy
        : undefined,
    totalPredictions:
      typeof value.totalPredictions === 'number' && Number.isFinite(value.totalPredictions)
        ? value.totalPredictions
        : undefined,
    correctPredictions:
      typeof value.correctPredictions === 'number' && Number.isFinite(value.correctPredictions)
        ? value.correctPredictions
        : undefined,
    lastSeen: value.lastSeen ?? value.updated ?? value.timestamp ?? fallbackTimestamp,
    created: value.created ?? value.timestamp ?? fallbackTimestamp,
    updated: value.updated ?? value.timestamp ?? fallbackTimestamp,
  });
}

function loadPatternMapFromChain(memphisDir: string): Map<string, DecisionPattern> {
  const rawEnv = { ...process.env, MEMPHIS_DATA_DIR: memphisDir };
  const patterns = new Map<string, DecisionPattern>();

  for (const chainDir of getReadableChainPaths('patterns', rawEnv)) {
    if (!fs.existsSync(chainDir)) continue;

    try {
      const files = fs
        .readdirSync(chainDir)
        .filter((entry) => /^\d+\.json$/.test(entry))
        .sort((left, right) => left.localeCompare(right));

      for (const file of files) {
        try {
          const payload = JSON.parse(fs.readFileSync(path.join(chainDir, file), 'utf8')) as {
            timestamp?: string;
            data?: Record<string, unknown>;
          };
          if (!payload.data || typeof payload.data !== 'object') continue;
          const pattern = hydratePatternFromBlock(payload.data, payload.timestamp);
          if (pattern) {
            patterns.set(pattern.id, pattern);
          }
        } catch (error) {
          const message = `Failed to load pattern block ${path.join(chainDir, file)}: ${String(error)}`;
          if (!seenPatternLoadWarnings.has(message)) {
            seenPatternLoadWarnings.add(message);
            logger.warn('Ignoring malformed pattern block', { error: message });
          }
        }
      }
    } catch (error) {
      const message = `Failed to scan pattern chain ${chainDir}: ${String(error)}`;
      if (!seenPatternLoadWarnings.has(message)) {
        seenPatternLoadWarnings.add(message);
        logger.warn('Failed to scan pattern chain', { error: message });
      }
    }
  }

  return patterns;
}

function fingerprintPattern(pattern: DecisionPattern): string {
  return JSON.stringify(serializePattern(pattern));
}

// ============================================================================
// PATTERN REGISTRY
// ============================================================================

export class PatternRegistry {
  private static loadLogged = false;
  private readonly memphisDir: string | null;
  private patterns: Map<string, DecisionPattern> = new Map();

  constructor(memphisDir?: string) {
    this.memphisDir = resolvePatternRuntimeDir(memphisDir);
    this.load();
  }

  /**
   * Loads persisted patterns from the patterns chain into memory.
   */
  load(): void {
    try {
      this.patterns = this.memphisDir ? loadPatternMapFromChain(this.memphisDir) : new Map();
      if (!PatternRegistry.loadLogged) {
        logger.info('Loaded patterns', { count: this.patterns.size });
        PatternRegistry.loadLogged = true;
      }
    } catch (error) {
      logger.warn('Failed to load patterns, starting fresh', { error: String(error) });
      this.patterns = new Map();
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
   * Stores a pattern in the current in-memory view.
   */
  set(pattern: DecisionPattern): void {
    this.patterns.set(pattern.id, pattern);
  }

  /**
   * Removes a pattern by identifier.
   */
  delete(id: string): boolean {
    return this.patterns.delete(id);
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
  private storage: PatternRegistry;
  private blocks: Block[];
  private config: ModelCConfig;
  private readonly store: IStore;

  constructor(blocks: Block[], config?: Partial<ModelCConfig>, store: IStore = new ChainStore()) {
    this.blocks = blocks;
    this.storage = new PatternRegistry();
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

    logger.info('Analyzing decisions', { count: decisions.length });

    // Group decisions by similar context
    const contextGroups = this.groupBySimilarContext(decisions);
    logger.info('Found context groups', { count: contextGroups.size });

    // Create patterns from groups with enough occurrences
    for (const [contextKey, group] of contextGroups) {
      if (group.length >= this.config.patternMinOccurrences) {
        const pattern = this.createPattern(contextKey, group);

        // Check if pattern already exists
        const existing = this.findSimilarPattern(pattern);
        if (existing) {
          const merged = this.mergePattern(existing, pattern);
          this.storage.set(merged);
          if (!this.patternsEqual(existing, merged)) {
            await this.persistPatternSafe(merged, 'updated');
          }
        } else {
          this.storage.set(pattern);
          await this.persistPatternSafe(pattern, 'created');
          newPatterns.push(pattern);
          logger.info('New pattern', { title: pattern.prediction.title });
        }
      }
    }

    logger.info('Created new patterns', { count: newPatterns.length, total: this.storage.count() });
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
          confidence =
            confidence * (1 - this.config.accuracyWeight) +
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

      if (
        !data ||
        !timestamp ||
        !chain ||
        typeof data.content !== 'string' ||
        typeof data.type !== 'string'
      ) {
        return [];
      }

      if (data.type !== 'decision' && data.type !== 'journal') {
        return [];
      }

      return [
        {
          ...block,
          timestamp,
          chain,
          data: {
            ...data,
            content: data.content,
            type: data.type,
            tags: Array.isArray(data.tags) ? data.tags : [],
          },
        },
      ];
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
    const firstSeen = this.getBoundaryTimestamp(group, 'first');
    const lastSeen = this.getBoundaryTimestamp(group, 'last');

    // Find most common content themes
    const themes = this.extractThemes(group);

    return {
      id: this.buildPatternId(_contextKey, commonTags),
      context,
      prediction: {
        type: this.classifyPatternType(context, commonTags),
        title: this.generatePatternTitle(themes, commonTags),
        confidence: Math.min(group.length / 10, this.config.confidenceCap),
        evidence: themes.slice(0, 3),
      },
      occurrences: group.length,
      lastSeen,
      created: firstSeen,
      updated: lastSeen,
    };
  }

  private buildPatternId(contextKey: string, tags: string[]): string {
    const hash = createHash('sha256')
      .update(`${contextKey}|${tags.slice(0, 5).join(',')}`)
      .digest('hex')
      .slice(0, 16);
    return `pattern-${hash}`;
  }

  private getBoundaryTimestamp(group: DecisionBlock[], boundary: 'first' | 'last'): Date {
    const timestamps = group
      .map((block) => new Date(block.timestamp).getTime())
      .filter((value) => Number.isFinite(value));
    if (timestamps.length === 0) return new Date(0);
    return new Date(boundary === 'first' ? Math.min(...timestamps) : Math.max(...timestamps));
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
    const wordCounts = new Map<string, number>();
    for (const block of group) {
      const content = block.data.content.toLowerCase();
      for (const word of content.split(/\W+/)) {
        if (word.length <= 4 || this.isStopWord(word)) {
          continue;
        }
        wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
      }
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
    return MODEL_C_STOP_WORDS.has(word);
  }

  /**
   * Classify pattern type
   */
  private classifyPatternType(
    context: DecisionContext,
    tags: string[],
  ): 'strategic' | 'tactical' | 'technical' {
    const strategicKeywords = ['roadmap', 'vision', 'milestone', 'release', 'launch'];
    const tacticalKeywords = ['sprint', 'task', 'feature', 'implement', 'build'];

    const allWords = [...tags, ...(context.activity || [])].join(' ').toLowerCase();

    if (strategicKeywords.some((kw) => allWords.includes(kw))) {
      return 'strategic';
    }
    if (tacticalKeywords.some((kw) => allWords.includes(kw))) {
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
    const exact = this.storage.get(pattern.id);
    if (exact) return exact;

    const patterns = this.storage.getAll();

    for (const existing of patterns) {
      const similarity = this.calculateContextSimilarity(pattern.context, existing.context);
      if (similarity >= this.config.contextSimilarityThreshold) {
        return existing;
      }
    }

    return undefined;
  }

  private mergePattern(existing: DecisionPattern, next: DecisionPattern): DecisionPattern {
    return {
      ...next,
      id: existing.id,
      created: existing.created,
      accuracy: existing.accuracy,
      totalPredictions: existing.totalPredictions,
      correctPredictions: existing.correctPredictions,
    };
  }

  private patternsEqual(left: DecisionPattern, right: DecisionPattern): boolean {
    return fingerprintPattern(left) === fingerprintPattern(right);
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
      let overlap = 0;
      for (const tag of ctx1.tags) {
        if (ctx2.tags.includes(tag)) {
          overlap += 1;
        }
      }

      const uniqueTags = new Set(ctx1.tags);
      for (const tag of ctx2.tags) {
        uniqueTags.add(tag);
      }

      if (uniqueTags.size > 0) {
        score += overlap / uniqueTags.size;
        factors++;
      }
    }

    // Chain match
    if (ctx1.chain && ctx2.chain) {
      score += ctx1.chain === ctx2.chain ? 1 : 0;
      factors++;
    }

    return factors > 0 ? score / factors : 0;
  }

  private async persistPattern(
    pattern: DecisionPattern,
    event: 'created' | 'updated' | 'accuracy-update',
  ): Promise<void> {
    const contextTags = pattern.context.tags?.slice(0, 3).join(', ') || 'no-tags';
    const content = [
      `Pattern ${event}: ${pattern.prediction.title}.`,
      `Seen ${pattern.occurrences} times in ${pattern.context.chain ?? 'unknown'} context.`,
      `Tags: ${contextTags}.`,
    ].join(' ');

    await appendDurableBlock(this.store, 'patterns', {
      type: 'insight',
      content,
      tags: ['model-c', 'pattern', event],
      metadata: {
        pattern: serializePattern(pattern),
        source: 'model-c',
        kind: 'pattern',
        event,
        patternId: pattern.id,
        context: pattern.context,
        prediction: pattern.prediction,
        occurrences: pattern.occurrences,
        accuracy: pattern.accuracy,
        totalPredictions: pattern.totalPredictions,
        correctPredictions: pattern.correctPredictions,
        lastSeen: pattern.lastSeen.toISOString(),
        created: pattern.created.toISOString(),
        updated: pattern.updated.toISOString(),
        timestamp: pattern.updated.toISOString(),
      },
    });
  }

  private async persistPatternSafe(
    pattern: DecisionPattern,
    event: 'created' | 'updated' | 'accuracy-update',
  ): Promise<void> {
    try {
      await this.persistPattern(pattern, event);
    } catch (error) {
      const message = String(error);
      if (!seenPatternPersistenceWarnings.has(message)) {
        seenPatternPersistenceWarnings.add(message);
        logger.warn('Failed to persist pattern event', { error: message });
      }
    }
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
      void this.persistPatternSafe(pattern, 'accuracy-update');
    }
  }

  /**
   * Get statistics
   */
  getStats(): { totalPatterns: number; avgOccurrences: number; avgAccuracy: number } {
    const patterns = this.storage.getAll();
    const totalPatterns = patterns.length;

    const avgOccurrences =
      patterns.length > 0
        ? patterns.reduce((sum, p) => sum + p.occurrences, 0) / patterns.length
        : 0;

    const patternsWithAccuracy = patterns.filter((p) => p.accuracy !== undefined);
    const avgAccuracy =
      patternsWithAccuracy.length > 0
        ? patternsWithAccuracy.reduce((sum, p) => sum + p.accuracy!, 0) /
          patternsWithAccuracy.length
        : 0;

    return { totalPatterns, avgOccurrences, avgAccuracy };
  }
}

/**
 * @deprecated Use PatternRegistry. Retained only for direct-import compatibility.
 */
export const PatternStorage = PatternRegistry;

export type { DecisionBlock };
