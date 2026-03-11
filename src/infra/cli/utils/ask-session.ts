import { createInterface } from 'node:readline/promises';
import { stdin as inputStream, stdout as outputStream } from 'node:process';
import {
  appendAskSessionTurn,
  askSessionStats,
  buildAskSessionPrompt,
  clearAskSession,
  estimateTokens,
  readAskSession,
  selectContextTurns,
} from '../../../core/ask-session-store.js';
import { print, printChat, printTuiAnswer } from './render.js';

type AskGenerateParams = {
  input: string;
  provider: 'auto' | 'shared-llm' | 'decentralized-llm' | 'local-fallback' | 'ollama';
  model?: string;
  strategy?: 'default' | 'latency-aware';
};

type AskGenerateResult = {
  id: string;
  providerUsed: string;
  modelUsed?: string;
  output: string;
  timingMs: number;
  usage?: { outputTokens?: number };
  trace?: { attempts: Array<{ provider: string; ok: boolean; latencyMs: number; viaFallback: boolean; errorCode?: string }> };
};

type AskOrchestration = {
  generate: (input: AskGenerateParams) => Promise<AskGenerateResult>;
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
  provider: 'auto' | 'shared-llm' | 'decentralized-llm' | 'local-fallback' | 'ollama';
  model?: string;
  strategy?: 'default' | 'latency-aware';
  json: boolean;
  tui: boolean;
  orchestration: AskOrchestration;
}): Promise<{ exit: boolean }> {
  const trimmed = params.rawInput.trim();

  if (trimmed === '/exit') {
    if (params.json) {
      print({ ok: true, mode: 'ask-session-exit', session: params.session }, true);
    } else {
      console.log(`session ${params.session} ended`);
    }
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
    print({ ok: true, mode: 'ask-session-save', session: params.session, turns: turns.length }, params.json);
    return { exit: false };
  }

  appendAskSessionTurn(
    params.session,
    {
      timestamp: new Date().toISOString(),
      role: 'user',
      content: params.rawInput,
      tokens: estimateTokens(params.rawInput),
    },
    process.env,
  );

  const turns = readAskSession(params.session, process.env);
  const stats = askSessionStats(turns, process.env);
  const context = selectContextTurns(turns, stats.contextTurns, stats.contextTokenLimit);
  const prompt = buildAskSessionPrompt(context, params.rawInput);

  const result = await params.orchestration.generate({
    input: prompt,
    provider: params.provider,
    model: params.model,
    strategy: params.strategy,
  });

  appendAskSessionTurn(
    params.session,
    {
      timestamp: new Date().toISOString(),
      role: 'assistant',
      content: result.output,
      tokens: result.usage?.outputTokens ?? estimateTokens(result.output),
    },
    process.env,
  );

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
    console.log(`warning: context window nearing limit (${refreshedStats.contextTokens}/${refreshedStats.contextTokenLimit} tokens)`);
  }

  return { exit: false };
}

export async function runAskSessionInteractive(params: {
  session: string;
  provider: 'auto' | 'shared-llm' | 'decentralized-llm' | 'local-fallback' | 'ollama';
  model?: string;
  strategy?: 'default' | 'latency-aware';
  json: boolean;
  tui: boolean;
  orchestration: AskOrchestration;
}): Promise<void> {
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
