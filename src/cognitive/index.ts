/**
 * Memphis Cognitive Layer — Index
 * 
 * Exports all cognitive models (A+B+C+D+E) and utilities
 */

// Types
export type {
  DecisionContext,
  Prediction,
  DecisionPattern,
  Reflection,
  ReflectionStats,
  Insight,
  Contradiction,
  ModelAConfig,
  ModelBConfig,
  ModelCConfig,
  ModelDConfig,
  ModelEConfig,
  AgentConfig,
  CognitiveModelType,
  CognitiveEngineConfig,
} from './types.js';

// Model C — Predictive Patterns
export { ModelC_PredictivePatterns, PatternStorage } from './model-c.js';
export type { DecisionBlock } from './model-c.js';

// Model D — Collective Coordination
export { 
  ModelD_CollectiveCoordination,
  AgentCoordinator,
} from './model-d.js';
export type {
  Proposal,
  Vote,
  DecisionResult,
  CollectiveDecision,
} from './model-d.js';

// Model E — Meta-Cognitive Reflection
export { ModelE_MetaCognitiveReflection } from './model-e.js';

// Insight Generator
export { 
  InsightGenerator, 
  quickInsight,
} from './insight-generator.js';
export type { InsightReport } from './insight-generator.js';

// Proactive Assistant
export {
  ProactiveAssistant,
  ASSISTANT_PRESETS,
} from './proactive-assistant.js';
export type {
  AssistantConfig,
  ProactiveMessage,
} from './proactive-assistant.js';

// Version
export const COGNITIVE_VERSION = '5.0.0';
export const COGNITIVE_MODELS = ['A', 'B', 'C', 'D', 'E'] as const;
