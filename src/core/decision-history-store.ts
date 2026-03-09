import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { DecisionRecord } from './decision-lifecycle.js';

export type DecisionHistoryEntry = {
  ts: string;
  decision: DecisionRecord;
};

export function decisionHistoryPath(path = 'data/decision-history.jsonl'): string {
  return resolve(path);
}

export function appendDecisionHistory(decision: DecisionRecord, path?: string): string {
  const target = decisionHistoryPath(path);
  mkdirSync(dirname(target), { recursive: true });
  const entry: DecisionHistoryEntry = { ts: new Date().toISOString(), decision };
  appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf8');
  return target;
}

export function readDecisionHistory(path?: string): DecisionHistoryEntry[] {
  const target = decisionHistoryPath(path);
  if (!existsSync(target)) return [];
  return readFileSync(target, 'utf8')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DecisionHistoryEntry);
}
