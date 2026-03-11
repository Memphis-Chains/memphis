/**
 * Phase 6 — Learning Persistence
 *
 * Saves and loads user feedback to improve categorization accuracy over time
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { LearningData, SuggestionFeedback } from './model-a-types.js';
import { getDataDir } from '../config/paths.js';

const LEARNING_DIR = path.join(getDataDir(), 'intelligence');
const LEARNING_FILE = path.join(LEARNING_DIR, 'learning-data.json');

function emptyLearningData(): LearningData {
  return {
    acceptedPatterns: new Map(),
    rejectedPatterns: new Map(),
    customTags: new Set(),
    tagAliases: new Map(),
  };
}

/**
 * Persistent learning storage
 */
export class LearningStorage {
  private data: LearningData;
  private filePath: string;

  constructor(customPath?: string) {
    this.filePath = customPath || LEARNING_FILE;
    this.data = this.load();
  }

  /**
   * Load learning data from disk
   */
  private load(): LearningData {
    try {
      if (!fs.existsSync(this.filePath)) {
        return emptyLearningData();
      }

      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw);

      return {
        acceptedPatterns: new Map(Object.entries(parsed.acceptedPatterns || {})),
        rejectedPatterns: new Map(Object.entries(parsed.rejectedPatterns || {})),
        customTags: new Set(parsed.customTags || []),
        tagAliases: new Map(Object.entries(parsed.tagAliases || {})),
      };
    } catch {
      // If loading fails, start fresh
      return emptyLearningData();
    }
  }

  /**
   * Save learning data to disk
   */
  save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const serializable = {
        acceptedPatterns: Object.fromEntries(this.data.acceptedPatterns),
        rejectedPatterns: Object.fromEntries(this.data.rejectedPatterns),
        customTags: Array.from(this.data.customTags),
        tagAliases: Object.fromEntries(this.data.tagAliases),
        lastUpdated: new Date().toISOString(),
      };

      fs.writeFileSync(this.filePath, JSON.stringify(serializable, null, 2));
    } catch (err) {
      console.error('Failed to save learning data:', err);
    }
  }

  /**
   * Record feedback (accept/reject/modify)
   */
  recordFeedback(feedback: SuggestionFeedback): void {
    const tag =
      feedback.action === 'modify'
        ? feedback.modifiedTag || feedback.suggested.tag
        : feedback.suggested.tag;

    if (feedback.action === 'accept') {
      const current = this.data.acceptedPatterns.get(tag) || 0;
      this.data.acceptedPatterns.set(tag, current + 1);
    } else if (feedback.action === 'reject') {
      const current = this.data.rejectedPatterns.get(tag) || 0;
      this.data.rejectedPatterns.set(tag, current + 1);
    } else if (feedback.action === 'modify' && feedback.modifiedTag) {
      this.data.tagAliases.set(feedback.suggested.tag, feedback.modifiedTag);
      this.data.customTags.add(feedback.modifiedTag);
    }

    this.save();
  }

  /**
   * Get acceptance rate for a tag (0.0-1.0)
   */
  getAcceptanceRate(tag: string): number {
    const accepted = this.data.acceptedPatterns.get(tag) || 0;
    const rejected = this.data.rejectedPatterns.get(tag) || 0;
    const total = accepted + rejected;

    if (total === 0) return 0.5;

    const baseRate = accepted / total;
    const confidenceScale = Math.min(total / 10, 1);
    const decayedRate = baseRate * (0.5 + 0.5 * confidenceScale);

    return Math.max(0.1, Math.min(0.9, decayedRate));
  }

  /**
   * Get rejection rate for a tag (0.0-1.0)
   */
  getRejectionRate(tag: string): number {
    return 1 - this.getAcceptanceRate(tag);
  }

  /**
   * Returns the learned alias for a tag, if one has been recorded.
   */
  getAlias(tag: string): string | undefined {
    return this.data.tagAliases.get(tag);
  }

  /**
   * Returns whether the tag was introduced through user customization.
   */
  isCustomTag(tag: string): boolean {
    return this.data.customTags.has(tag);
  }

  /**
   * Lists all custom tags learned from feedback.
   */
  getCustomTags(): string[] {
    return Array.from(this.data.customTags);
  }

  /**
   * Returns the most frequently accepted tags.
   */
  getTopAccepted(limit = 10): Array<{ tag: string; count: number }> {
    return Array.from(this.data.acceptedPatterns.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([tag, count]) => ({ tag, count }));
  }

  /**
   * Returns the most frequently rejected tags.
   */
  getTopRejected(limit = 10): Array<{ tag: string; count: number }> {
    return Array.from(this.data.rejectedPatterns.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([tag, count]) => ({ tag, count }));
  }

  /**
   * Summarizes the current learning dataset and feedback counts.
   */
  getStats(): {
    totalFeedback: number;
    acceptedTags: number;
    rejectedTags: number;
    customTags: number;
    aliases: number;
    topAccepted: Array<{ tag: string; count: number }>;
    topRejected: Array<{ tag: string; count: number }>;
  } {
    const topAccepted = this.getTopAccepted(10);
    const topRejected = this.getTopRejected(10);

    const totalAccepted = Array.from(this.data.acceptedPatterns.values()).reduce(
      (sum, count) => sum + count,
      0,
    );
    const totalRejected = Array.from(this.data.rejectedPatterns.values()).reduce(
      (sum, count) => sum + count,
      0,
    );

    return {
      totalFeedback: totalAccepted + totalRejected,
      acceptedTags: totalAccepted,
      rejectedTags: totalRejected,
      customTags: this.data.customTags.size,
      aliases: this.data.tagAliases.size,
      topAccepted,
      topRejected,
    };
  }

  /**
   * Resets all learned feedback and persists the empty state.
   */
  clear(): void {
    this.data = emptyLearningData();
    this.save();
  }

  /**
   * Exports the learning dataset as a JSON string.
   */
  export(): string {
    return JSON.stringify(
      {
        acceptedPatterns: Object.fromEntries(this.data.acceptedPatterns),
        rejectedPatterns: Object.fromEntries(this.data.rejectedPatterns),
        customTags: Array.from(this.data.customTags),
        tagAliases: Object.fromEntries(this.data.tagAliases),
      },
      null,
      2,
    );
  }

  /**
   * Replaces the current learning dataset with the provided JSON payload.
   */
  import(jsonData: string): void {
    try {
      const parsed = JSON.parse(jsonData);

      this.data = {
        acceptedPatterns: new Map(Object.entries(parsed.acceptedPatterns || {})),
        rejectedPatterns: new Map(Object.entries(parsed.rejectedPatterns || {})),
        customTags: new Set(parsed.customTags || []),
        tagAliases: new Map(Object.entries(parsed.tagAliases || {})),
      };

      this.save();
    } catch (err) {
      throw new Error(`Failed to import learning data: ${String(err)}`, { cause: err });
    }
  }
}

let learningStorage: LearningStorage | null = null;

export function getLearningStorage(): LearningStorage {
  if (!learningStorage) {
    learningStorage = new LearningStorage();
  }
  return learningStorage;
}
