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
export { ModelD_CollectiveCoordination, AgentCoordinator } from './model-d.js';
export type { Proposal, Vote, DecisionResult, CollectiveDecision } from './model-d.js';

// Model D.2 — Social Intelligence
export { AgentRegistry } from './agent-registry.js';
export { RelationshipGraph } from './relationship-graph.js';
export { CollaborativeFilter } from './collaborative-filter.js';
export { TrustMetrics } from './trust-metrics.js';
export type {
  AgentIdentity,
  AgentRelationship,
  Suggestion,
  Decision,
  TrustEdge,
  RelationshipType,
} from './model-d-types.js';

// Model E — Meta-Cognitive Reflection
export { ModelE_MetaCognitiveReflection } from './model-e.js';

// Model E — Creative Synthesis
export { KnowledgeSynthesizer } from './knowledge-synthesizer.js';
export { ConnectionDiscovery } from './connection-discovery.js';
export { InsightGenerator, quickInsight } from './insight-generator.js';
export { ProactiveSuggestionEngine } from './proactive-suggestions.js';
export type {
  Connection,
  Recommendation,
  Topic,
  KnowledgeGap,
  Insight as ModelEInsight,
  ProactiveSuggestion,
} from './model-e-types.js';
export type { InsightReport } from './insight-generator.js';

// Proactive Assistant
export { ProactiveAssistant, ASSISTANT_PRESETS } from './proactive-assistant.js';
export type { AssistantConfig, ProactiveMessage } from './proactive-assistant.js';

// Version
export const COGNITIVE_VERSION = '5.0.0';
export const COGNITIVE_MODELS = ['A', 'B', 'C', 'D', 'E'] as const;
