import { stdin as inputStream, stdout as outputStream } from 'node:process';
import { createInterface } from 'node:readline/promises';

import { runChatTurn, type ChatState } from '../chat-turn.js';
import { print, printChat, printTuiAnswer } from './render.js';
import {
  appendAskSessionTurn,
  askSessionStats,
  buildAskSessionMessages,
  clearAskSession,
  estimateTokens,
  readAskSession,
  selectContextTurns,
} from '../../../core/ask-session-store.js';
import type { RequestedProviderName } from '../../../core/types.js';

type AskGenerateResult = {
  id: string;
  providerUsed: string;
  modelUsed?: string;
  output: string;
  timingMs: number;
  usage?: { outputTokens?: number };
  trace?: {
    attempts: Array<{
      provider: string;
      ok: boolean;
      latencyMs: number;
      viaFallback: boolean;
      errorCode?: string;
    }>;
  };
};

export type AskSessionRuntime = Pick<
  ChatState,
  'provider' | 'memory' | 'userId' | 'model' | 'systemPrompt' | 'tools' | 'toolExecutor'
>;

function buildAskSessionState(
  runtime: AskSessionRuntime,
  session: string,
  rawInput: string,
): { chatState: ChatState; userTurn: string } {
  const turns = readAskSession(session, process.env);
  const stats = askSessionStats(turns, process.env);
  const contextTurns = selectContextTurns(turns, stats.contextTurns, stats.contextTokenLimit);
  return {
    chatState: {
      ...runtime,
      userId: runtime.userId ?? `cli:ask-session:${session}`,
      messages: buildAskSessionMessages(contextTurns),
    },
    userTurn: rawInput,
  };
}

function toAskGenerateResult(result: Awaited<ReturnType<typeof runChatTurn>>): AskGenerateResult {
  return {
    id: `ask_${Date.now().toString(36)}`,
    providerUsed: result.provider,
    modelUsed: result.model,
    output: result.output,
    timingMs: result.timingMs,
    usage: { outputTokens: estimateTokens(result.output) },
  };
}

function appendAskSessionExchange(session: string, rawInput: string, output: string): void {
  appendAskSessionTurn(
    session,
    {
      timestamp: new Date().toISOString(),
      role: 'user',
      content: rawInput,
      tokens: estimateTokens(rawInput),
    },
    process.env,
  );

  appendAskSessionTurn(
    session,
    {
      timestamp: new Date().toISOString(),
      role: 'assistant',
      content: output,
      tokens: estimateTokens(output),
    },
    process.env,
  );
}

type AskSessionModeParams = {
  session: string;
  provider: RequestedProviderName;
  model?: string;
  strategy?: 'default' | 'latency-aware';
  json: boolean;
  tui: boolean;
  runtime: AskSessionRuntime;
};

export function printAskSessionContext(name: string, asJson: boolean): void {
  const turns = readAskSession(name, process.env);
  const stats = askSessionStats(turns, process.env);
  if (asJson) {
    print({ ok: true, mode: 'ask-session-context', session: name, ...stats }, true);
    return;
  }
  console.log(`session: ${name}`);
  console.log(`turns: ${stats.turns}`);
  console.log(`tokens: ${stats.tokens}`);
  console.log(`contextTurns: ${stats.contextTurns}`);
  console.log(`contextTokens: ${stats.contextTokens}/${stats.contextTokenLimit}`);
  if (stats.warning) {
    console.log('warning: context window usage is above 80%');
  }
}

export async function runAskSessionTurn(params: {
  session: string;
  rawInput: string;
  json: boolean;
  tui: boolean;
  runtime: AskSessionRuntime;
}): Promise<{ exit: boolean }> {
  const trimmed = params.rawInput.trim();
  const commandOutcome = handleAskSessionMetaCommand(trimmed, params);
  if (commandOutcome) return commandOutcome;

  const deterministicRecall = buildLocalFallbackRecallAnswer(
    params.session,
    params.rawInput,
    params.runtime.provider.name,
  );
  if (deterministicRecall) {
    appendAskSessionExchange(params.session, params.rawInput, deterministicRecall.output);
    const refreshedStats = askSessionStats(readAskSession(params.session, process.env), process.env);
    if (params.json) {
      print({ ...deterministicRecall, session: params.session, context: refreshedStats }, true);
      return { exit: false };
    }
    if (params.tui) {
      printTuiAnswer(deterministicRecall);
    } else {
      printChat(deterministicRecall);
    }
    return { exit: false };
  }

  const { chatState, userTurn } = buildAskSessionState(
    params.runtime,
    params.session,
    params.rawInput,
  );
  const result = toAskGenerateResult(await runChatTurn(chatState, userTurn));

  appendAskSessionExchange(params.session, params.rawInput, result.output);

  const refreshedStats = askSessionStats(readAskSession(params.session, process.env), process.env);
  if (params.json) {
    print({ ...result, session: params.session, context: refreshedStats }, true);
    return { exit: false };
  }

  if (params.tui) {
    printTuiAnswer(result);
  } else {
    printChat(result);
  }

  if (refreshedStats.warning) {
    console.log(
      `warning: context window nearing limit (${refreshedStats.contextTokens}/${refreshedStats.contextTokenLimit} tokens)`,
    );
  }

  return { exit: false };
}

function buildLocalFallbackRecallAnswer(
  session: string,
  rawInput: string,
  providerName: string,
): AskGenerateResult | undefined {
  if (providerName !== 'local-fallback') return undefined;
  if (!/what did i just say\??/i.test(rawInput.trim())) return undefined;
  const previousUserTurn = readAskSession(session, process.env)
    .filter((turn) => turn.role === 'user' && turn.content.trim().length > 0)
    .at(-1);
  if (!previousUserTurn) return undefined;
  const output = `Fallback response: ${previousUserTurn.content}`;
  return {
    id: `ask_${Date.now().toString(36)}`,
    providerUsed: 'local-fallback',
    modelUsed: 'local-fallback-v0',
    output,
    timingMs: 0,
    usage: { outputTokens: estimateTokens(output) },
  };
}

function handleAskSessionMetaCommand(
  trimmed: string,
  params: {
    session: string;
    json: boolean;
  },
): { exit: boolean } | undefined {
  if (trimmed === '/exit') {
    if (params.json) print({ ok: true, mode: 'ask-session-exit', session: params.session }, true);
    else console.log(`session ${params.session} ended`);
    return { exit: true };
  }
  if (trimmed === '/context') {
    printAskSessionContext(params.session, params.json);
    return { exit: false };
  }
  if (trimmed === '/clear') {
    const path = clearAskSession(params.session, process.env);
    print({ ok: true, mode: 'ask-session-clear', session: params.session, path }, params.json);
    return { exit: false };
  }
  if (trimmed === '/save') {
    const turns = readAskSession(params.session, process.env);
    print(
      { ok: true, mode: 'ask-session-save', session: params.session, turns: turns.length },
      params.json,
    );
    return { exit: false };
  }
  return undefined;
}

export async function runAskSessionInteractive(params: AskSessionModeParams): Promise<void> {
  const rl = createInterface({ input: inputStream, output: outputStream });
  console.log(`session mode: ${params.session} (commands: /context /clear /save /exit)`);
  try {
    while (true) {
      const line = await rl.question(`memphis:${params.session}> `);
      if (line.trim().length === 0) continue;
      const outcome = await runAskSessionTurn({ ...params, rawInput: line });
      if (outcome.exit) break;
    }
  } finally {
    rl.close();
  }
}
