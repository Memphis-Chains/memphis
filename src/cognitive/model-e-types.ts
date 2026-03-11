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

export interface Insight {
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
