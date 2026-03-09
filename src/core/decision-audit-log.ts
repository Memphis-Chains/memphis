import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export type DecisionAuditEvent = {
  ts: string;
  decisionId: string;
  action: 'create' | 'transition';
  from?: string;
  to?: string;
  actor?: string;
  note?: string;
};

export type DecisionAuditAppendResult = {
  eventId: string;
  path: string;
};

export function decisionAuditPath(path = 'data/decision-audit.jsonl'): string {
  return resolve(path);
}

export function appendDecisionAudit(event: DecisionAuditEvent, path?: string): DecisionAuditAppendResult {
  const target = decisionAuditPath(path);
  const eventId = randomUUID();
  mkdirSync(dirname(target), { recursive: true });
  appendFileSync(target, `${JSON.stringify({ eventId, ...event })}\n`, 'utf8');
  return { eventId, path: target };
}

export function readDecisionAudit(path?: string): Array<DecisionAuditEvent & { eventId?: string }> {
  const target = decisionAuditPath(path);
  if (!existsSync(target)) return [];
  const lines = readFileSync(target, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((line) => JSON.parse(line) as DecisionAuditEvent & { eventId?: string });
}
