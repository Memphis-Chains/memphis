import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type DecisionAuditEvent = {
  ts: string;
  decisionId: string;
  action: 'create' | 'transition';
  from?: string;
  to?: string;
  actor?: string;
  note?: string;
};

export function decisionAuditPath(path = 'data/decision-audit.jsonl'): string {
  return resolve(path);
}

export function appendDecisionAudit(event: DecisionAuditEvent, path?: string): string {
  const target = decisionAuditPath(path);
  mkdirSync(dirname(target), { recursive: true });
  appendFileSync(target, `${JSON.stringify(event)}\n`, 'utf8');
  return target;
}

export function readDecisionAudit(path?: string): DecisionAuditEvent[] {
  const target = decisionAuditPath(path);
  if (!existsSync(target)) return [];
  const lines = readFileSync(target, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((line) => JSON.parse(line) as DecisionAuditEvent);
}
