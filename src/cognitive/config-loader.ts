/**
 * Cognitive Config Loader
 *
 * Loads cognitive engine configuration from environment variables,
 * with fallback to default values defined in each model.
 */

import type {
  CognitiveEngineConfig,
  ModelAConfig,
  ModelBConfig,
  ModelCConfig,
  ModelDConfig,
  ModelEConfig,
} from './types.js';
import { parseBool } from '../core/env.js';


type CaptureLevel = 'minimal' | 'normal' | 'verbose';
type ReflectionSchedule = 'daily' | 'weekly' | 'both';

/**
 * Default configuration for Model A (Conscious Capture)
 */
const DEFAULT_MODEL_A: ModelAConfig = {
  autoCapture: true,
  captureLevel: 'normal',
  requireConfirmation: true,
};

/**
 * Default configuration for Model B (Inferred Decisions)
 */
const DEFAULT_MODEL_B: ModelBConfig = {
  gitWatchEnabled: false,
  fileWatchEnabled: false,
  repoPath: process.cwd(),
  sinceDays: 7,
  maxCommits: 100,
  activityWindowSize: 6,
  behaviorAnalysisWindow: 30,
  confidenceThreshold: 0.45,
  minConfidence: 0.3,
  includeMerges: false,
};

/**
 * Default configuration for Model C (Predictive Patterns)
 */
const DEFAULT_MODEL_C: ModelCConfig = {
  patternMinOccurrences: 3,
  confidenceCap: 0.85,
  contextSimilarityThreshold: 0.75,
  recencyBoost: 0.1,
  accuracyWeight: 0.5,
  predictionCooldown: 5000,
};

/**
 * Default configuration for Model D (Collective Coordination)
 */
const DEFAULT_MODEL_D: ModelDConfig = {
  consensusThreshold: 0.6,
  votingTimeout: 30000,
  agents: [],
};

/**
 * Default configuration for Model E (Meta-Cognitive Reflection)
 */
const DEFAULT_MODEL_E: ModelEConfig = {
  reflectionSchedule: 'both',
  deepAnalysisDay: 0,
  contradictionDetection: true,
  blindSpotAnalysis: true,
};

/**
 * Loads the cognitive engine configuration from environment variables.
 *
 * Priority: env var > default value
 *
 * @param env - Environment variables (defaults to process.env)
 * @returns Complete cognitive engine configuration
 */
export function loadCognitiveConfig(env: NodeJS.ProcessEnv = process.env): CognitiveEngineConfig {
  // Model A config
  const modelA: ModelAConfig = {
    autoCapture: parseBool(env.COGNITIVE_MODEL_A_AUTO_CAPTURE, DEFAULT_MODEL_A.autoCapture),
    captureLevel:
      (env.COGNITIVE_MODEL_A_CAPTURE_LEVEL as CaptureLevel) ?? DEFAULT_MODEL_A.captureLevel,
    requireConfirmation: parseBool(
      env.COGNITIVE_MODEL_A_REQUIRE_CONFIRMATION,
      DEFAULT_MODEL_A.requireConfirmation,
    ),
  };

  // Model B config
  const modelB: ModelBConfig = {
    gitWatchEnabled: parseBool(
      env.COGNITIVE_MODEL_B_GIT_WATCH_ENABLED,
      DEFAULT_MODEL_B.gitWatchEnabled,
    ),
    fileWatchEnabled: parseBool(
      env.COGNITIVE_MODEL_B_FILE_WATCH_ENABLED,
      DEFAULT_MODEL_B.fileWatchEnabled,
    ),
    repoPath: env.COGNITIVE_MODEL_B_REPO_PATH ?? DEFAULT_MODEL_B.repoPath,
    sinceDays: env.COGNITIVE_MODEL_B_SINCE_DAYS
      ? Number(env.COGNITIVE_MODEL_B_SINCE_DAYS)
      : DEFAULT_MODEL_B.sinceDays,
    maxCommits: env.COGNITIVE_MODEL_B_MAX_COMMITS
      ? Number(env.COGNITIVE_MODEL_B_MAX_COMMITS)
      : DEFAULT_MODEL_B.maxCommits,
    activityWindowSize: env.COGNITIVE_MODEL_B_ACTIVITY_WINDOW_SIZE
      ? Number(env.COGNITIVE_MODEL_B_ACTIVITY_WINDOW_SIZE)
      : DEFAULT_MODEL_B.activityWindowSize,
    behaviorAnalysisWindow: DEFAULT_MODEL_B.behaviorAnalysisWindow,
    confidenceThreshold: env.COGNITIVE_MODEL_B_CONFIDENCE_THRESHOLD
      ? Number(env.COGNITIVE_MODEL_B_CONFIDENCE_THRESHOLD)
      : DEFAULT_MODEL_B.confidenceThreshold,
    minConfidence: DEFAULT_MODEL_B.minConfidence,
    includeMerges: parseBool(
      env.COGNITIVE_MODEL_B_INCLUDE_MERGES,
      DEFAULT_MODEL_B.includeMerges,
    ),
  };

  // Model C config
  const modelC: ModelCConfig = {
    patternMinOccurrences: env.COGNITIVE_MODEL_C_PATTERN_MIN_OCCURRENCES
      ? Number(env.COGNITIVE_MODEL_C_PATTERN_MIN_OCCURRENCES)
      : DEFAULT_MODEL_C.patternMinOccurrences,
    confidenceCap: env.COGNITIVE_MODEL_C_CONFIDENCE_CAP
      ? Number(env.COGNITIVE_MODEL_C_CONFIDENCE_CAP)
      : DEFAULT_MODEL_C.confidenceCap,
    contextSimilarityThreshold: env.COGNITIVE_MODEL_C_CONTEXT_SIMILARITY_THRESHOLD
      ? Number(env.COGNITIVE_MODEL_C_CONTEXT_SIMILARITY_THRESHOLD)
      : DEFAULT_MODEL_C.contextSimilarityThreshold,
    recencyBoost: env.COGNITIVE_MODEL_C_RECENCY_BOOST
      ? Number(env.COGNITIVE_MODEL_C_RECENCY_BOOST)
      : DEFAULT_MODEL_C.recencyBoost,
    accuracyWeight: env.COGNITIVE_MODEL_C_ACCURACY_WEIGHT
      ? Number(env.COGNITIVE_MODEL_C_ACCURACY_WEIGHT)
      : DEFAULT_MODEL_C.accuracyWeight,
    predictionCooldown: DEFAULT_MODEL_C.predictionCooldown,
  };

  // Model D config
  const modelD: ModelDConfig = {
    consensusThreshold: env.COGNITIVE_MODEL_D_CONSENSUS_THRESHOLD
      ? Number(env.COGNITIVE_MODEL_D_CONSENSUS_THRESHOLD)
      : DEFAULT_MODEL_D.consensusThreshold,
    votingTimeout: env.COGNITIVE_MODEL_D_VOTING_TIMEOUT_MS
      ? Number(env.COGNITIVE_MODEL_D_VOTING_TIMEOUT_MS)
      : DEFAULT_MODEL_D.votingTimeout,
    agents: DEFAULT_MODEL_D.agents,
  };

  // Model E config
  const modelE: ModelEConfig = {
    reflectionSchedule:
      (env.COGNITIVE_MODEL_E_REFLECTION_SCHEDULE as ReflectionSchedule) ??
      DEFAULT_MODEL_E.reflectionSchedule,
    deepAnalysisDay: env.COGNITIVE_MODEL_E_DEEP_ANALYSIS_DAY
      ? Number(env.COGNITIVE_MODEL_E_DEEP_ANALYSIS_DAY)
      : DEFAULT_MODEL_E.deepAnalysisDay,
    contradictionDetection: parseBool(
      env.COGNITIVE_MODEL_E_CONTRADICTION_DETECTION,
      DEFAULT_MODEL_E.contradictionDetection,
    ),
    blindSpotAnalysis: parseBool(
      env.COGNITIVE_MODEL_E_BLIND_SPOT_ANALYSIS,
      DEFAULT_MODEL_E.blindSpotAnalysis,
    ),
  };

  return {
    modelA,
    modelB,
    modelC,
    modelD,
    modelE,
  };
}
