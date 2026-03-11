/**
 * Phase 6 — Auto-Categorization Engine
 * 
 * Fast, intelligent tag suggestions using pattern matching, context inference, and LLM fallback
 */

import type { 
  CategorySuggestion, 
  TagSuggestion, 
  CategorizerConfig,
  InferenceContext,
  SuggestionSource,
  TagPattern,
  SuggestionFeedback,
  TagCategory
} from './model-a-types.js';
import { getPatternsByPriority } from './patterns.js';
import { getLearningStorage } from './learning.js';
import { resolveProvider } from '../providers/factory.js';
import type { Block } from '../memory/chain.js';
import { getRecentBlocks } from '../infra/storage/rust-chain-adapter.js';
import { embedSearch } from '../infra/storage/rust-embed-adapter.js';

/**
 * Default configuration for the categorizer
 */
const DEFAULT_CONFIG: CategorizerConfig = {
  enablePatternMatching: true,
  enableContextInference: true,
  enableLLMFallback: false, // Disabled by default (requires API calls)
  confidenceThreshold: 0.6,
  maxSuggestions: 5,
  learningEnabled: true
};

/**
 * Main categorization engine
 */
export class Categorizer {
  private config: CategorizerConfig;
  private learningStorage;

  constructor(config: Partial<CategorizerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.learningStorage = getLearningStorage();
  }

  /**
   * Main entry point: Suggest tags for content
   */
  async suggestCategories(
    content: string, 
    context?: InferenceContext
  ): Promise<CategorySuggestion> {
    const startTime = Date.now();
    const allSuggestions: TagSuggestion[] = [];

    // Step 1: Pattern matching (fast, local)
    if (this.config.enablePatternMatching) {
      const patternSuggestions = this.matchPatterns(content);
      allSuggestions.push(...patternSuggestions);
    }

    // Step 2: Context inference (medium speed)
    if (this.config.enableContextInference && context) {
      const contextSuggestions = this.inferFromContext(content, context);
      allSuggestions.push(...contextSuggestions);
    }

    // Step 3: LLM fallback (slow, accurate) - only if not enough high-confidence suggestions
    if (this.config.enableLLMFallback && this.needsLLMFallback(allSuggestions)) {
      const llmSuggestions = await this.classifyWithLLM(content);
      allSuggestions.push(...llmSuggestions);
    }

    // Step 4: Merge, dedupe, and rank
    const merged = this.mergeAndRank(allSuggestions);
    
    // Step 5: Filter by confidence and limit
    const filtered = merged
      .filter(s => s.confidence >= this.config.confidenceThreshold)
      .slice(0, this.config.maxSuggestions);

    const processingTime = Date.now() - startTime;

    return {
      tags: filtered,
      overallConfidence: this.calculateOverallConfidence(filtered),
      processingTimeMs: processingTime,
      method: this.determineMethod(allSuggestions)
    };
  }

  /**
   * Pattern matching (fast, local)
   */
  private matchPatterns(content: string): TagSuggestion[] {
    const suggestions: TagSuggestion[] = [];
    const patterns = getPatternsByPriority();

    for (const pattern of patterns) {
      for (const regex of pattern.patterns) {
        // Reset regex lastIndex (for global flags)
        regex.lastIndex = 0;
        
        if (regex.test(content)) {
          const suggestion = this.createSuggestionFromPattern(pattern, content, regex);
          suggestions.push(suggestion);
          break; // Only one match per pattern
        }
      }
    }

    return suggestions;
  }

  /**
   * Create suggestion from pattern match
   */
  private createSuggestionFromPattern(
    pattern: TagPattern, 
    content: string, 
    matchedRegex: RegExp
  ): TagSuggestion {
    // Calculate confidence based on pattern priority and learning data
    let confidence = pattern.priority / 100; // Normalize to 0-1

    // Adjust confidence based on user feedback (from persistent storage)
    if (this.config.learningEnabled) {
      const acceptanceRate = this.learningStorage.getAcceptanceRate(pattern.tag);
      if (acceptanceRate !== 0.5) { // Has feedback
        confidence = confidence * 0.5 + acceptanceRate * 0.5; // Blend
      }
    }

    // Extract evidence (snippet around the match)
    const evidence = this.extractEvidence(content, matchedRegex);

    return {
      tag: pattern.tag,
      category: pattern.category,
      confidence: Math.min(confidence, 1),
      source: 'pattern',
      evidence
    };
  }

  /**
   * Context inference (medium speed)
   */
  private inferFromContext(
    content: string, 
    context: InferenceContext
  ): TagSuggestion[] {
    const suggestions: TagSuggestion[] = [];

    // 1. Infer project tags from recent blocks
    if (context.activeProjects.length > 0) {
      for (const project of context.activeProjects) {
        // Check if content might be related to this project
        const projectKeywords = project.toLowerCase().split(/[-_\s]+/);
        const contentLower = content.toLowerCase();
        const matchCount = projectKeywords.filter(kw => contentLower.includes(kw)).length;
        
        if (matchCount >= projectKeywords.length * 0.5) {
          suggestions.push({
            tag: `project:${project}`,
            category: 'project',
            confidence: 0.5 + (matchCount / projectKeywords.length) * 0.3,
            source: 'context',
            evidence: `Related to recent project: ${project}`
          });
        }
      }
    }

    // 2. Infer tags from frequent tags
    if (context.frequentTags.length > 0) {
      // If user frequently uses certain tags, suggest them with lower confidence
      const topTags = context.frequentTags.slice(0, 3);
      for (const tag of topTags) {
        // Don't duplicate pattern matches
        suggestions.push({
          tag,
          category: 'custom',
          confidence: 0.4, // Lower confidence for context-only
          source: 'context',
          evidence: `Frequently used tag`
        });
      }
    }

    // 3. Time-based inference
    const timeTag = this.inferTimeTag(context.timeOfDay, context.dayOfWeek);
    if (timeTag) {
      suggestions.push(timeTag);
    }

    return suggestions;
  }

  /**
   * Infer time-based tag
   */
  private inferTimeTag(
    timeOfDay: InferenceContext['timeOfDay'], 
    _dayOfWeek: string
  ): TagSuggestion | null {
    // Skip weekend tags entirely - they're low value
    // Users don't care about "weekend" classification
    
    // Time of day with stricter rules
    if (timeOfDay === 'morning') {
      return {
        tag: 'morning',
        category: 'time',
        confidence: 0.35, // Reduced from 0.5
        source: 'context',
        evidence: 'Morning entry'
      };
    } else if (timeOfDay === 'evening' || timeOfDay === 'night') {
      return {
        tag: 'eod',
        category: 'type',
        confidence: 0.35, // Reduced from 0.5
        source: 'context',
        evidence: 'Evening entry, likely end-of-day'
      };
    }

    return null;
  }

  /**
   * LLM classification (slow, accurate)
   * Zero-shot classification using LLM provider
   */
  private async classifyWithLLM(content: string): Promise<TagSuggestion[]> {
    try {
      // Resolve provider - prefer smaller/faster models for classification
      // Try in order: qwen2.5:0.5b > phi3 > qwen2.5-coder:3b (fallback)
      let resolved = await resolveProvider({ 
        provider: 'ollama',
        model: 'qwen2.5:0.5b',
        skipOpenClaw: true 
      });
      
      // Fallback to default if qwen2.5:0.5b not available
      if (!resolved) {
        resolved = await resolveProvider({ 
          provider: 'ollama',
          model: 'phi3',
          skipOpenClaw: true 
        });
      }
      
      // Final fallback to default provider
      if (!resolved) {
        resolved = await resolveProvider({ skipOpenClaw: true });
      }
      
      if (!resolved) {
        return [];
      }
      
      // Create zero-shot classification prompt
      const prompt = `Classify the following text with relevant tags. Return only a JSON array of tags with confidence scores.

Text: "${content}"

Available tag categories:
- Type: meeting, decision, bug, feature, learning, insight, question, idea, goal, progress, problem, solution, review, docs, test, refactor, eod, weekly
- Priority: high, medium, low
- Tech: tech:javascript, tech:typescript, tech:react, tech:python, tech:rust, tech:go, tech:database, tech:docker, tech:git, tech:api
- Mood: positive, negative
- Scope: work, personal

Return format (JSON array):
[
  {"tag": "meeting", "confidence": 0.95, "reason": "Contains meeting indicator"},
  {"tag": "tech:database", "confidence": 0.80, "reason": "Mentions PostgreSQL"}
]

Rules:
- Only include tags with confidence > 0.6
- Maximum 5 tags
- Be specific (use tech:* tags when possible)
- Consider context and intent

Return ONLY the JSON array, no other text:`;

      // Call LLM with timeout (max 3 seconds for classification)
      const timeoutPromise = new Promise<null>((_, reject) => 
        setTimeout(() => reject(new Error('LLM classification timeout')), 3000)
      );
      
      const response = await Promise.race([
        resolved.provider.chat([
          { role: 'user', content: prompt }
        ], {
          model: resolved.model,
          temperature: 0.3,
          max_tokens: 200 // Reduced from 500 for faster response
        }),
        timeoutPromise
      ]) as { content?: string };
      
      if (!response || !response.content) {
        return [];
      }

      // Parse JSON response
      const jsonMatch = response.content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]);
      
      // Convert to TagSuggestion format
      const suggestions: TagSuggestion[] = parsed.map((item: { tag: string; confidence?: number; reason?: string }) => ({
        tag: item.tag.toLowerCase(),
        category: this.inferCategory(item.tag),
        confidence: Math.min(item.confidence || 0.7, 1),
        source: 'llm' as SuggestionSource,
        evidence: item.reason || 'LLM classification'
      }));

      return suggestions;
    } catch {
      // LLM classification is best-effort, don't fail on errors
      return [];
    }
  }

  /**
   * Infer category from tag name
   */
  private inferCategory(tag: string): TagCategory {
    if (tag.startsWith('tech:')) return 'tech';
    if (tag.startsWith('project:')) return 'project';
    if (tag.startsWith('person:')) return 'person';
    if (['high', 'medium', 'low'].includes(tag)) return 'priority';
    if (['positive', 'negative'].includes(tag)) return 'mood';
    if (['morning', 'eod', 'weekly'].includes(tag)) return 'time';
    if (['work', 'personal'].includes(tag)) return 'scope';
    return 'type';
  }

  /**
   * Check if we need LLM fallback
   */
  private needsLLMFallback(suggestions: TagSuggestion[]): boolean {
    // Only use LLM if we have less than 2 high-confidence suggestions (>80%)
    const highConfidence = suggestions.filter(s => s.confidence > 0.8);
    return highConfidence.length < 2;
  }

  /**
   * Merge and rank suggestions
   */
  private mergeAndRank(suggestions: TagSuggestion[]): TagSuggestion[] {
    // Group by tag
    const byTag = new Map<string, TagSuggestion[]>();
    
    for (const suggestion of suggestions) {
      const existing = byTag.get(suggestion.tag) || [];
      existing.push(suggestion);
      byTag.set(suggestion.tag, existing);
    }

    // Merge duplicates, keeping highest confidence
    const merged: TagSuggestion[] = [];
    
    for (const [, duplicates] of byTag) {
      // Sort by confidence
      duplicates.sort((a, b) => b.confidence - a.confidence);
      
      // Take the best one
      const best = duplicates[0];
      
      // If we have multiple sources, boost confidence slightly
      if (duplicates.length > 1) {
        best.confidence = Math.min(best.confidence * 1.1, 1);
        best.evidence = duplicates.map(d => d.evidence).filter(Boolean).join('; ');
      }
      
      merged.push(best);
    }

    // Sort by confidence (highest first)
    merged.sort((a, b) => b.confidence - a.confidence);

    return merged;
  }

  /**
   * Calculate overall confidence
   */
  private calculateOverallConfidence(suggestions: TagSuggestion[]): number {
    if (suggestions.length === 0) return 0;
    
    const sum = suggestions.reduce((acc, s) => acc + s.confidence, 0);
    return sum / suggestions.length;
  }

  /**
   * Determine which method was primarily used
   */
  private determineMethod(suggestions: TagSuggestion[]): 'pattern' | 'context' | 'llm' | 'hybrid' {
    const sources = new Set(suggestions.map(s => s.source));
    
    if (sources.size === 1) {
      return sources.values().next().value as 'pattern' | 'context' | 'llm';
    }
    
    return 'hybrid';
  }

  /**
   * Extract evidence snippet around the match
   */
  private extractEvidence(content: string, regex: RegExp): string {
    regex.lastIndex = 0;
    const match = regex.exec(content);
    
    if (!match) return '';
    
    const matchedText = match[0];
    const startIdx = Math.max(0, match.index - 20);
    const endIdx = Math.min(content.length, match.index + matchedText.length + 20);
    
    const snippet = content.slice(startIdx, endIdx);
    const prefix = startIdx > 0 ? '...' : '';
    const suffix = endIdx < content.length ? '...' : '';
    
    return `${prefix}${snippet}${suffix}`;
  }

  /**
   * Learn from user feedback (persistent)
   */
  learnFromFeedback(tag: string, accepted: boolean, modifiedTag?: string): void {
    if (!this.config.learningEnabled) return;

    const feedback: SuggestionFeedback = {
      suggested: {
        tag,
        category: 'custom',
        confidence: 0,
        source: 'pattern'
      },
      action: accepted ? 'accept' : (modifiedTag ? 'modify' : 'reject'),
      modifiedTag,
      context: {
        content: '',
        timestamp: new Date()
      }
    };

    this.learningStorage.recordFeedback(feedback);
  }

  /**
   * Get learning statistics
   */
  getLearningStats() {
    return this.learningStorage.getStats();
  }

  /**
   * Update configuration
   */
  updateConfig(newConfig: Partial<CategorizerConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Get current configuration
   */
  getConfig(): CategorizerConfig {
    return { ...this.config };
  }
}

/**
 * Quick categorization function (sugar for common case)
 */
export async function categorize(
  content: string, 
  context?: InferenceContext
): Promise<CategorySuggestion> {
  const categorizer = new Categorizer({ enableLLMFallback: true });
  return categorizer.suggestCategories(content, context);
}

/**
 * Build inference context from recent blocks
 */
export function buildInferenceContext(recentBlocks: Block[]): InferenceContext {
  const now = new Date();
  const hour = now.getHours();
  
  // Determine time of day
  let timeOfDay: InferenceContext['timeOfDay'];
  if (hour >= 6 && hour < 12) {
    timeOfDay = 'morning';
  } else if (hour >= 12 && hour < 18) {
    timeOfDay = 'afternoon';
  } else if (hour >= 18 && hour < 22) {
    timeOfDay = 'evening';
  } else {
    timeOfDay = 'night';
  }

  // Extract active projects from recent blocks
  const activeProjects = extractActiveProjects(recentBlocks);

  // Extract frequent tags from recent blocks
  const frequentTags = extractFrequentTags(recentBlocks);

  return {
    recentBlocks,
    activeProjects,
    frequentTags,
    timeOfDay,
    dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long' })
  };
}

/**
 * Extract active projects from recent blocks
 */
function extractActiveProjects(blocks: Block[]): string[] {
  const projectCounts = new Map<string, number>();

  for (const block of blocks) {
    // Look for project: tags
    const projectTags = block.data?.tags?.filter((t: string) => t.startsWith('project:')) || [];
    for (const tag of projectTags) {
      const project = tag.replace('project:', '');
      projectCounts.set(project, (projectCounts.get(project) || 0) + 1);
    }

    // Also look for common project mentions in content
    const projectMentions = block.data?.content?.match(/\b[A-Z][a-z]+(?:[-\s][A-Z]?[a-z]+)*\b/g) || [];
    for (const mention of projectMentions) {
      // Filter out common words
      const commonWords = ['The', 'This', 'Today', 'Yesterday', 'Meeting', 'Decision', 'Bug', 'Feature'];
      if (!commonWords.includes(mention)) {
        projectCounts.set(mention, (projectCounts.get(mention) || 0) + 0.5); // Lower weight for mentions
      }
    }
  }

  // Sort by frequency and return top 5
  return Array.from(projectCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([project]) => project);
}

/**
 * Extract frequent tags from recent blocks
 */
function extractFrequentTags(blocks: Block[]): string[] {
  const tagCounts = new Map<string, number>();

  for (const block of blocks) {
    for (const tag of block.data?.tags || []) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }

  // Sort by frequency and return top 10
  return Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([tag]) => tag);
}

/**
 * v5 adapter helper: categorize using latest chain context + embedding hints.
 */
export async function categorizeWithV5Context(content: string): Promise<CategorySuggestion> {
  const recentBlocks = await getRecentBlocks('journal', 20);
  const context = buildInferenceContext(recentBlocks);

  // Warm embedding retrieval path (best-effort; logic remains pattern/context-first)
  try {
    embedSearch(content, 3);
  } catch {
    // no-op: embedding backend might be disabled
  }

  const categorizer = new Categorizer({ enableLLMFallback: false });
  return categorizer.suggestCategories(content, context);
}
