export type RelationshipType = 'trusts' | 'collaborates' | 'mentors';

export interface AgentIdentity {
  did: string;
  name: string;
  publicKey: string;
  capabilities: string[];
  reputation: number; // 0-100
  lastSeen: Date;
}

export interface AgentRelationship {
  from: string;
  to: string;
  type: RelationshipType;
  strength: number; // 0-1
  interactions: number;
  lastInteraction: Date;
}

export interface Suggestion {
  id: string;
  topic: string;
  score: number;
  reason: string;
}

export interface Decision {
  topic: string;
  winner: string;
  confidence: number;
  votes: Array<{ option: string; score: number }>;
}

export interface TrustEdge {
  from: string;
  to: string;
  score: number; // 0-1
  interactions: number;
  lastUpdated: Date;
}
