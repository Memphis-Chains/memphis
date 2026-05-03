import type { Block } from '../memory/chain.js';

export interface Connection {
  topics: string[];
  strength: number;
  evidence: Block[];
  novelty: number;
  description: string;
}

export interface Recommendation {
  title: string;
  rationale: string;
  confidence: number;
  actions: string[];
}

export interface Topic {
  name: string;
  weight: number;
  bridgeScore: number;
}

export interface KnowledgeGap {
  topic: string;
  reason: string;
  severity: 'low' | 'medium' | 'high';
  suggestedAction: string;
}

/**
 * Model E's view of an insight, distinct from the broader cognitive
 * `Insight` shape in `cognitive/types.ts`. The two interfaces are
 * incompatible (different `type` unions, `evidence: Block[]` vs
 * `string[]`, `actions?: string[]` vs `suggestedAction?: string`),
 * so they live under different names. Issue #397 required this split
 * because any callsite that imported both ended up with a name
 * collision and ambiguous semantics.
 *
 * Choose `ModelEInsight` when the producer reasons about Block[]
 * evidence (Model E reflective passes); choose `Insight` from
 * `cognitive/types.ts` for the broader cognitive layer (Model B/C
 * decisions, peak-hour productivity reports, etc.).
 */
export interface ModelEInsight {
  type: 'pattern' | 'anomaly' | 'prediction' | 'recommendation';
  title: string;
  description: string;
  confidence: number;
  evidence: Block[];
  actionable: boolean;
  actions?: string[];
}

export interface ProactiveSuggestion {
  type: 'journal' | 'reflect' | 'decide' | 'sync' | 'review';
  message: string;
  priority: 'low' | 'medium' | 'high';
  action?: () => Promise<void>;
  dismissible: boolean;
}
