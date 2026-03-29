/**
 * Cognitive Engine Modes — A/B/C/D/E configuration
 *
 * Each mode has distinct temperature, style, and reasoning pattern
 * for the cognitive engine's LLM calls.
 */

export const COGNITIVE_MODES = {
  A: {
    name: 'ConsciousCapture',
    temperature: 0.3,
    style: 'fast',
    pattern: 'concise',
    description: 'Quick, minimal context captures — fast pattern matching',
  },
  B: {
    name: 'InferredDecisions',
    temperature: 0.5,
    style: 'deliberate',
    pattern: 'detailed',
    description: 'Deep analysis with evidence chains — detailed reasoning',
  },
  C: {
    name: 'PredictivePatterns',
    temperature: 0.7,
    style: 'reflective',
    pattern: 'analogical',
    description: 'Pattern recognition and prediction — analogical thinking',
  },
  D: {
    name: 'CollectiveCoord',
    temperature: 0.4,
    style: 'collaborative',
    pattern: 'socratic',
    description: 'Multi-agent coordination — socratic questioning',
  },
  E: {
    name: 'MetaCognitiveRef',
    temperature: 0.2,
    style: 'meta',
    pattern: 'concise',
    description: 'Self-reflection and monitoring — minimal, targeted',
  },
} as const;

export type CognitiveMode = keyof typeof COGNITIVE_MODES;

export interface CognitiveModeConfig {
  name: string;
  temperature: number;
  style: string;
  pattern: string;
  description: string;
}

export function getCognitiveModeConfig(mode: CognitiveMode): CognitiveModeConfig {
  return COGNITIVE_MODES[mode] ?? COGNITIVE_MODES.A;
}

export function isValidCognitiveMode(value: string): value is CognitiveMode {
  return value in COGNITIVE_MODES;
}

export function getDefaultCognitiveMode(): CognitiveMode {
  return 'A';
}
