import { AskSession } from '../../../cli/ask-session.js';
import { runTuiApp } from '../../../tui/index.js';
import type { CliContext } from '../context.js';
import { runInteractiveTui } from '../interactive-tui.js';
import { runAskSessionInteractive, runAskSessionTurn } from '../utils/ask-session.js';
import { print, printChat, printTuiAnswer } from '../utils/render.js';

type InteractionHandler = (context: CliContext) => Promise<boolean>;

export async function handleInteractionCommand(context: CliContext): Promise<boolean> {
  const command = context.args.command;
  const handlers: Partial<Record<string, InteractionHandler>> = {
    'ask-session': handleAskSessionCommand,
    'providers:health': handleProvidersHealthCommand,
    tui: handleTuiCommand,
    chat: handleChatLikeCommand,
    ask: handleChatLikeCommand,
  };
  const handler = command ? handlers[command] : undefined;
  return handler ? handler(context) : false;
}

async function handleAskSessionCommand(context: CliContext): Promise<boolean> {
  const { provider, model, strategy, maxTokens, contextWindow, temperature, systemPrompt } =
    context.args;
  const sessionRunner = new AskSession({
    provider: provider ?? 'auto',
    model: model ?? 'gpt-4',
    strategy: strategy ?? 'default',
    maxTokens: maxTokens ?? 2048,
    contextWindow: contextWindow ?? 8192,
    temperature: temperature ?? 0.7,
    systemPrompt,
  });
  await sessionRunner.start();
  return true;
}

async function handleProvidersHealthCommand(context: CliContext): Promise<boolean> {
  const config = context.getConfig();
  const providers = await context.getContainer().orchestration.providersHealth();
  print({ defaultProvider: config.DEFAULT_PROVIDER, providers }, context.args.json);
  return true;
}

async function handleTuiCommand(context: CliContext): Promise<boolean> {
  const { provider, model, strategy } = context.args;
  await runTuiApp({
    orchestration: context.getContainer().orchestration,
    provider: provider ?? 'auto',
    model,
    strategy,
  });
  return true;
}

async function handleChatLikeCommand(context: CliContext): Promise<boolean> {
  const { command, session, interactive, input, provider, model, strategy, json, tui } =
    context.args;
  if (session && command !== 'ask') throw new Error('--session is supported only for ask command');
  if (command === 'ask' && session) return handleAskSessionMode(context);
  if (interactive) return handleInteractiveChat(context);
  if (!input || input.trim().length === 0)
    throw new Error('Missing required --input for chat/ask command');
  await renderChatLikeResult(
    context,
    { input, provider: provider ?? 'auto', model, strategy },
    json,
    tui,
  );
  return true;
}

async function renderChatLikeResult(
  context: CliContext,
  request: {
    input: string;
    provider: 'auto' | 'shared-llm' | 'decentralized-llm' | 'local-fallback' | 'ollama';
    model?: string;
    strategy?: 'default' | 'latency-aware';
  },
  json: boolean,
  tui: boolean,
): Promise<void> {
  const result = await context.getContainer().orchestration.generate(request);
  if (json) print(result, true);
  else if (tui) printTuiAnswer(result);
  else printChat(result);
}

async function handleAskSessionMode(context: CliContext): Promise<boolean> {
  const { session, interactive, input, provider, model, strategy, json, tui } = context.args;
  if (!session) throw new Error('Missing required --session for ask command in session mode');

  if (interactive && (!input || input.trim().length === 0)) {
    await runAskSessionInteractive({
      session,
      orchestration: context.getContainer().orchestration,
      provider: provider ?? 'auto',
      model,
      strategy,
      json,
      tui,
    });
    return true;
  }

  if (!input || input.trim().length === 0) {
    throw new Error(
      'Missing required --input for ask command in session mode (or use --interactive)',
    );
  }

  await runAskSessionTurn({
    session,
    rawInput: input,
    orchestration: context.getContainer().orchestration,
    provider: provider ?? 'auto',
    model,
    strategy,
    json,
    tui,
  });
  return true;
}

async function handleInteractiveChat(context: CliContext): Promise<boolean> {
  const { provider, model, strategy } = context.args;
  await runInteractiveTui({
    orchestration: context.getContainer().orchestration,
    provider: provider ?? 'auto',
    model,
    strategy,
  });
  return true;
}
