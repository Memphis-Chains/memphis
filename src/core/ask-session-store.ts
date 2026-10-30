import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

import type { ChatMessage } from '../providers/index.js';

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
  const hasControl = Array.from(name).some((character) => {
    const code = character.codePointAt(0)!;
    return code < 32 || code === 127;
  });
  if (!name.trim() || name === '.' || name === '..' || /[\\/:]/u.test(name) || hasControl) {
    throw new Error(
      'Invalid session name: use a name without path separators or control characters.',
    );
  }
  return resolve(askSessionsDir(env), `${name}.jsonl`);
}

function noFollow(): number {
  if (
    typeof constants.O_NOFOLLOW !== 'number' ||
    constants.O_NOFOLLOW === 0 ||
    typeof constants.O_NONBLOCK !== 'number' ||
    constants.O_NONBLOCK === 0
  ) {
    throw new Error('Session storage requires nonblocking, no-follow file opens.');
  }
  return constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

function ensurePrivateRegularFile(fd: number): void {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.nlink > 1) {
    throw new Error('Session storage requires a regular file with no hard links.');
  }
}

export function readAskSession(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): AskSessionTurn[] {
  const target = askSessionPath(name, env);
  if (!existsSync(target)) return [];
  const fd = openSync(target, constants.O_RDONLY | noFollow());
  try {
    ensurePrivateRegularFile(fd);
    return readFileSync(fd, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AskSessionTurn);
  } finally {
    closeSync(fd);
  }
}

export function appendAskSessionTurn(
  name: string,
  turn: AskSessionTurn,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const target = askSessionPath(name, env);
  mkdirSync(dirname(target), { recursive: true });
  const fd = openSync(
    target,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow(),
    0o600,
  );
  try {
    ensurePrivateRegularFile(fd);
    appendFileSync(fd, `${JSON.stringify(turn)}\n`, 'utf8');
  } finally {
    closeSync(fd);
  }
  return target;
}

export function clearAskSession(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const target = askSessionPath(name, env);
  mkdirSync(dirname(target), { recursive: true });
  const fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | noFollow(), 0o600);
  try {
    ensurePrivateRegularFile(fd);
    ftruncateSync(fd, 0);
  } finally {
    closeSync(fd);
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

export function selectContextTurns(
  turns: AskSessionTurn[],
  maxTurns: number,
  maxTokens: number,
): AskSessionTurn[] {
  const picked: AskSessionTurn[] = [];
  let tokens = 0;
  for (let i = turns.length - 1; i >= 0 && picked.length < Math.max(1, maxTurns); i -= 1) {
    const turn = turns[i];
    if (turn.tokens > maxTokens) continue;
    if (tokens + turn.tokens > maxTokens) continue;
    picked.push(turn);
    tokens += turn.tokens;
  }
  return picked.reverse();
}

export function askSessionStats(
  turns: AskSessionTurn[],
  env: NodeJS.ProcessEnv = process.env,
): {
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

export function buildAskSessionMessages(contextTurns: AskSessionTurn[]): ChatMessage[] {
  return contextTurns.map((turn) => ({
    role: turn.role,
    content: turn.content,
  }));
}
