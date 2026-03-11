/**
 * Memphis Cognitive Types
 * 
 * Shared types for all cognitive models (A+B+C+D+E)
 */

// ============================================================================
// CORE TYPES
// ============================================================================

export interface DecisionContext {
  files?: string[];           // ["src/api/*.ts"]
  branches?: string[];        // ["feature/*"]
  activity?: string[];        // ["new-feature", "refactor"]
  timeOfDay?: number;         // 0-23
  dayOfWeek?: number;         // 0-6 (Sunday = 0)
  recentCommits?: number;     // Count in last 24h
  recentDecisions?: number;   // Count in last 7 days
  tags?: string[];            // Related tags
  chain?: string;             // Source chain
}

export interface Prediction {
  type: 'strategic' | 'tactical' | 'technical';
  title: string;
  confidence: number;         // 0.0-0.95 (never 100%)
  basedOn: string[];          // Decision IDs / block hashes
  evidence: string[];         // Short descriptions
  pattern?: DecisionPattern;
  suggestedAction?: string;   // What to do next
  reasoning?: string;         // Why this prediction
}

export interface DecisionPattern {
  id: string;
  context: DecisionContext;
  prediction: {
    type: 'strategic' | 'tactical' | 'technical';
    title: string;
    confidence: number;
    evidence: string[];
  };
  occurrences: number;        // How often this pattern appears
  lastSeen: Date;
  accuracy?: number;          // How often prediction was correct
  totalPredictions?: number;
  correctPredictions?: number;
  created: Date;
  updated: Date;
}

export interface Reflection {
  period: 'daily' | 'weekly' | 'deep';
  stats: ReflectionStats;
  insights: Insight[];
  themes: string[];
  contradictions: Contradiction[];
  blindSpots: string[];
  recommendations: string[];
  timestamp: Date;
}

export interface ReflectionStats {
  totalEntries: number;
  entriesPerDay: number;
  topTags: Array<{ tag: string; count: number }>;
  topChains: Array<{ chain: string; count: number }>;
  timeDistribution: {
    morning: number;   // 6-12
    afternoon: number; // 12-18
    evening: number;   // 18-24
    night: number;     // 0-6
  };
  averageEntryLength: number;
  questionsAsked: number;
  decisionsRecorded: number;
}

export interface Insight {
  type: 'pattern' | 'anomaly' | 'trend' | 'opportunity' | 'risk';
  title: string;
  description: string;
  confidence: number;
  evidence: string[];
  actionable: boolean;
  suggestedAction?: string;
}

export interface Contradiction {
  id: string;
  type: 'temporal' | 'logical' | 'behavioral';
  description: string;
  block1: string;  // Block hash or ID
  block2: string;
  severity: 'low' | 'medium' | 'high';
  resolution?: string;
}

// ============================================================================
// MODEL TYPES
// ============================================================================

export interface ModelAConfig {
  autoCapture: boolean;
  captureLevel: 'minimal' | 'normal' | 'verbose';
  requireConfirmation: boolean;
}

export interface ModelBConfig {
  gitWatchEnabled: boolean;
  fileWatchEnabled: boolean;
  behaviorAnalysisWindow: number;  // days
  minConfidence: number;
}

export interface ModelCConfig {
  patternMinOccurrences: number;
  confidenceCap: number;
  contextSimilarityThreshold: number;
  recencyBoost: number;
  accuracyWeight: number;
  predictionCooldown: number;  // ms
}

export interface ModelDConfig {
  consensusThreshold: number;  // 0.0-1.0
  votingTimeout: number;  // ms
  agents: AgentConfig[];
}

export interface ModelEConfig {
  reflectionSchedule: 'daily' | 'weekly' | 'both';
  deepAnalysisDay: number;  // 0-6 (Sunday = 0)
  contradictionDetection: boolean;
  blindSpotAnalysis: boolean;
}

export interface AgentConfig {
  id: string;
  name: string;
  endpoint: string;
  publicKey: string;
  weight: number;  // Voting weight
}

// ============================================================================
// FEEDBACK & LEARNING
// ============================================================================

export interface SuggestionFeedback {
  tag: string;
  accepted: boolean;
  timestamp: number;
  source: 'pattern' | 'context' | 'llm';
}

export interface LearningStorage {
  getAcceptanceRate(tag: string): number;
  recordFeedback(feedback: SuggestionFeedback): void;
  getRecentFeedback(limit?: number): SuggestionFeedback[];
  clear(): void;
}

// ============================================================================
// EXPORTS
// ============================================================================

export type CognitiveModelType = 'A' | 'B' | 'C' | 'D' | 'E';

export interface CognitiveEngineConfig {
  modelA: ModelAConfig;
  modelB: ModelBConfig;
  modelC: ModelCConfig;
  modelD: ModelDConfig;
  modelE: ModelEConfig;
  enabled: CognitiveModelType[];
}
