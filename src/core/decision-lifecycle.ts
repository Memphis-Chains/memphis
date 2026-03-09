export type DecisionStatus = 'proposed' | 'accepted' | 'implemented' | 'verified' | 'superseded' | 'rejected';

export type DecisionRecord = {
  id: string;
  title: string;
  context?: string;
  options: string[];
  chosen?: string;
  confidence: number;
  status: DecisionStatus;
  schemaVersion: 1;
  createdAt: string;
  updatedAt: string;
  refs?: string[];
};

const ALLOWED: Record<DecisionStatus, DecisionStatus[]> = {
  proposed: ['accepted', 'rejected', 'superseded'],
  accepted: ['implemented', 'superseded'],
  implemented: ['verified', 'superseded'],
  verified: ['superseded'],
  superseded: [],
  rejected: [],
};

export function transitionDecision(record: DecisionRecord, to: DecisionStatus, nowIso = new Date().toISOString()): DecisionRecord {
  const allowed = ALLOWED[record.status] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(`invalid transition: ${record.status} -> ${to}`);
  }
  return {
    ...record,
    status: to,
    updatedAt: nowIso,
  };
}

export function createDecision(params: {
  id: string;
  title: string;
  options?: string[];
  chosen?: string;
  context?: string;
  confidence?: number;
  refs?: string[];
  nowIso?: string;
}): DecisionRecord {
  const now = params.nowIso ?? new Date().toISOString();
  const options = params.options ?? [];
  return {
    id: params.id,
    title: params.title,
    context: params.context,
    options,
    chosen: params.chosen,
    confidence: params.confidence ?? 0.7,
    status: 'proposed',
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
    refs: params.refs,
  };
}
