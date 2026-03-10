import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type AskSessionRole = 'user' | 'assistant' | 'system';

export type AskSessionTurn = {
  timestamp: string;
  role: AskSessionRole;
  content: string;
  tokens: number;
};

export function estimateTokens(content: string): number {
  return Math.max(1, Math.ceil(content.length / 4));
}

export function askSessionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.ASK_SESSIONS_DIR ?? 'data/sessions');
}

export function askSessionPath(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return resolve(askSessionsDir(env), `${name}.jsonl`);
}

export function readAskSession(name: string, env: NodeJS.ProcessEnv = process.env): AskSessionTurn[] {
  const target = askSessionPath(name, env);
  if (!existsSync(target)) return [];
  return readFileSync(target, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AskSessionTurn);
}

export function appendAskSessionTurn(name: string, turn: AskSessionTurn, env: NodeJS.ProcessEnv = process.env): string {
  const target = askSessionPath(name, env);
  mkdirSync(dirname(target), { recursive: true });
  appendFileSync(target, `${JSON.stringify(turn)}\n`, 'utf8');
  return target;
}

export function clearAskSession(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const target = askSessionPath(name, env);
  mkdirSync(dirname(target), { recursive: true });
  if (existsSync(target)) {
    truncateSync(target, 0);
  } else {
    writeFileSync(target, '', 'utf8');
  }
  return target;
}

export function askSessionContextTurns(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ASK_CONTEXT_TURNS ?? 10);
  if (!Number.isFinite(raw) || raw <= 0) return 10;
  return Math.trunc(raw);
}

export function askSessionContextWindowTokens(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.ASK_CONTEXT_WINDOW_TOKENS ?? 4000);
  if (!Number.isFinite(raw) || raw <= 0) return 4000;
  return Math.trunc(raw);
}

export function selectContextTurns(turns: AskSessionTurn[], maxTurns: number, maxTokens: number): AskSessionTurn[] {
  const byTurns = turns.slice(-Math.max(1, maxTurns));
  const picked: AskSessionTurn[] = [];
  let tokens = 0;
  for (let i = byTurns.length - 1; i >= 0; i -= 1) {
    const turn = byTurns[i];
    if (picked.length > 0 && tokens + turn.tokens > maxTokens) break;
    picked.push(turn);
    tokens += turn.tokens;
  }
  return picked.reverse();
}

export function askSessionStats(turns: AskSessionTurn[], env: NodeJS.ProcessEnv = process.env): {
  turns: number;
  tokens: number;
  contextTurns: number;
  contextTokens: number;
  contextTokenLimit: number;
  warning: boolean;
} {
  const contextTurns = askSessionContextTurns(env);
  const contextTokenLimit = askSessionContextWindowTokens(env);
  const context = selectContextTurns(turns, contextTurns, contextTokenLimit);
  const tokens = turns.reduce((sum, turn) => sum + turn.tokens, 0);
  const contextTokens = context.reduce((sum, turn) => sum + turn.tokens, 0);
  return {
    turns: turns.length,
    tokens,
    contextTurns: context.length,
    contextTokens,
    contextTokenLimit,
    warning: contextTokens >= Math.floor(contextTokenLimit * 0.8),
  };
}

export function buildAskSessionPrompt(contextTurns: AskSessionTurn[], currentInput: string): string {
  if (contextTurns.length === 0) return currentInput;
  const transcript = contextTurns.map((turn) => `${turn.role.toUpperCase()}: ${turn.content}`).join('\n');
  return [
    'Use the conversation context below when answering the latest user input.',
    '',
    transcript,
    '',
    `USER: ${currentInput}`,
    'ASSISTANT:',
  ].join('\n');
}
