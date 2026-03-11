/**
 * Phase 6 — Intelligence Types
 * 
 * Core types for auto-categorization, suggestions, and conflict detection
 */

import type { Block } from '../memory/chain.js';

/**
 * Tag category for classification
 */
export type TagCategory = 
  | 'type'        // meeting, decision, bug, feature, learning, etc.
  | 'project'     // project:*, product:*, etc.
  | 'person'      // @mentions, person:*, etc.
  | 'tech'        // tech:*, language:*, framework:*, etc.
  | 'priority'    // high, medium, low, urgent
  | 'mood'        // positive, neutral, negative
  | 'scope'       // work, personal, side-project, etc.
  | 'time'        // morning, eod, weekly, etc.
  | 'custom';     // User-defined tags

/**
 * Source of tag suggestion
 */
export type SuggestionSource = 
  | 'pattern'     // Regex pattern match (fast, local)
  | 'context'     // Inferred from recent blocks
  | 'llm';        // LLM classification (accurate, slower)

/**
 * Single tag suggestion with metadata
 */
export interface TagSuggestion {
  tag: string;
  category: TagCategory;
  confidence: number;        // 0-1 confidence score
  source: SuggestionSource;
  evidence?: string;         // Why this tag was suggested
}

/**
 * Complete categorization result
 */
export interface CategorySuggestion {
  tags: TagSuggestion[];
  overallConfidence: number; // 0-1 overall confidence
  processingTimeMs: number;  // How long it took
  method: 'pattern' | 'context' | 'llm' | 'hybrid';
}

/**
 * Pattern for regex-based matching
 */
export interface TagPattern {
  tag: string;
  category: TagCategory;
  patterns: RegExp[];
  examples: string[];        // Example content that matches
  priority: number;          // Higher = checked first
}

/**
 * Context for inference
 */
export interface InferenceContext {
  recentBlocks: Block[];     // Last N blocks for context
  activeProjects: string[];  // Projects mentioned recently
  frequentTags: string[];    // Tags used frequently
  timeOfDay: 'morning' | 'afternoon' | 'evening' | 'night';
  dayOfWeek: string;
}

/**
 * User feedback on suggestion
 */
export interface SuggestionFeedback {
  suggested: TagSuggestion;
  action: 'accept' | 'reject' | 'modify';
  modifiedTag?: string;      // If user modified the tag
  context: {
    content: string;
    timestamp: Date;
    userId?: string;
  };
}

/**
 * Learning data for personalization
 */
export interface LearningData {
  acceptedPatterns: Map<string, number>;  // pattern -> acceptance count
  rejectedPatterns: Map<string, number>;  // pattern -> rejection count
  customTags: Set<string>;                // User-defined tags
  tagAliases: Map<string, string>;        // typo -> correct tag
}

/**
 * Configuration for categorizer
 */
export interface CategorizerConfig {
  enablePatternMatching: boolean;
  enableContextInference: boolean;
  enableLLMFallback: boolean;
  confidenceThreshold: number;   // Minimum confidence to suggest
  maxSuggestions: number;        // Max tags to suggest
  patternDbPath?: string;        // Custom pattern database
  learningEnabled: boolean;      // Learn from user feedback
}

/**
 * Default configuration
 */
export const DEFAULT_CATEGORIZER_CONFIG: CategorizerConfig = {
  enablePatternMatching: true,
  enableContextInference: true,
  enableLLMFallback: true,
  confidenceThreshold: 0.6,    // 60% confidence minimum
  maxSuggestions: 5,           // Max 5 tags suggested
  learningEnabled: true
};

/**
 * Proactive suggestion types
 */
export type SuggestionType = 
  | 'journal'     // "You haven't journaled in X hours"
  | 'reflect'     // "Time for daily reflection"
  | 'decide'      // "Seems like you're deciding something"
  | 'sync'        // "Share chain needs syncing"
  | 'embed'       // "New blocks need embeddings"
  | 'review';     // "Decision needs review"

/**
 * Proactive suggestion
 */
export interface ProactiveSuggestion {
  type: SuggestionType;
  message: string;
  priority: 'low' | 'medium' | 'high';
  action?: () => Promise<void>;
  dismissible: boolean;
  snoozable: boolean;
  snoozeDuration?: number;  // ms
}

/**
 * Conflict types
 */
export type ConflictType = 
  | 'contradiction'  // Direct contradiction
  | 'evolution'      // Belief changed over time
  | 'stale';         // Information outdated

/**
 * Detected conflict
 */
export interface Conflict {
  type: ConflictType;
  newBlock: Block;
  conflictingBlock: Block;
  severity: 'low' | 'medium' | 'high';
  resolution?: string;
  detectedAt: Date;
}

/**
 * Smart summary types
 */
export interface SmartSummary {
  period: 'daily' | 'weekly' | 'monthly';
  themes: string[];
  trends: Trend[];
  actions: string[];
  highlights: Block[];
  sentiment: 'positive' | 'neutral' | 'negative';
  generatedAt: Date;
}

/**
 * Trend detected in summary
 */
export interface Trend {
  description: string;
  direction: 'up' | 'down' | 'stable';
  percentage?: number;
  evidence: Block[];
}

/**
 * Graph insight types
 */
export type GraphInsightType = 
  | 'connection'   // Hidden connection discovered
  | 'cluster'      // Topic cluster detected
  | 'bridge'       // Bridge node (connects topics)
  | 'gap';         // Knowledge gap identified

/**
 * Graph insight
 */
export interface GraphInsight {
  type: GraphInsightType;
  description: string;
  evidence: Block[];
  confidence: number;
  actionable: boolean;
  suggestedAction?: string;
}
