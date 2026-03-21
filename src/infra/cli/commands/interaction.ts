import { AskSession } from '../../../cli/ask-session.js';
import { buildRuntimeSystemPrompt } from '../../../gateway/agent-runtime.js';
import { createInProcessToolExecutor } from '../../../gateway/tool-executor.js';
import { resolveProvider, defaultProviderConfig } from '../../../providers/index.js';
import { runTuiApp } from '../../../tui/index.js';
import { runChatTurn } from '../../../tui/screens/chat-screen.js';
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

  const runtime = await resolveAgentRuntime({ forceChatRuntime: true });

  await runTuiApp({
    orchestration: context.getContainer().orchestration,
    provider: provider ?? 'auto',
    model,
    strategy,
    chatProvider: runtime?.chatProvider,
    systemPrompt: runtime?.systemPrompt,
    tools: runtime?.tools,
    toolExecutor: runtime?.toolExecutor,
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
  const runtime = await resolveAgentRuntime({
    requestedProvider: request.provider,
    defaultProvider: String(context.getConfig().DEFAULT_PROVIDER ?? 'auto'),
  });
  const result = runtime
    ? await runInteractiveAgentTurn(runtime, request)
    : await context.getContainer().orchestration.generate(request);
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
  const runtime = await resolveAgentRuntime({
    requestedProvider: provider ?? 'auto',
    defaultProvider: String(context.getConfig().DEFAULT_PROVIDER ?? 'auto'),
    forceChatRuntime: true,
  });
  await runInteractiveTui({
    orchestration: context.getContainer().orchestration,
    provider: provider ?? 'auto',
    model,
    strategy,
    chatProvider: runtime?.chatProvider,
    systemPrompt: runtime?.systemPrompt,
    tools: runtime?.tools,
    toolExecutor: runtime?.toolExecutor,
  });
  return true;
}

type ResolvedAgentRuntime = {
  chatProvider: Awaited<ReturnType<typeof resolveProvider>>;
  systemPrompt: string;
  tools: ReturnType<ReturnType<typeof createInProcessToolExecutor>['listTools']>;
  toolExecutor: ReturnType<typeof createInProcessToolExecutor>['execute'];
};

async function resolveAgentRuntime(options: {
  requestedProvider?: 'auto' | 'shared-llm' | 'decentralized-llm' | 'local-fallback' | 'ollama';
  defaultProvider?: string;
  forceChatRuntime?: boolean;
} = {}): Promise<ResolvedAgentRuntime | undefined> {
  if (!options.forceChatRuntime) {
    const requested = options.requestedProvider ?? 'auto';
    const defaultProvider = options.defaultProvider ?? 'auto';
    const wantsTextOnlyRuntime =
      requested === 'local-fallback' ||
      requested === 'shared-llm' ||
      requested === 'decentralized-llm' ||
      (requested === 'auto' &&
        (defaultProvider === 'local-fallback' ||
          defaultProvider === 'shared-llm' ||
          defaultProvider === 'decentralized-llm'));
    if (wantsTextOnlyRuntime) {
      return undefined;
    }
  }

  try {
    const chatProvider = await resolveProvider(defaultProviderConfig());
    const toolExecutor = createInProcessToolExecutor();
    const tools = toolExecutor.listTools();
    return {
      chatProvider,
      systemPrompt: buildRuntimeSystemPrompt({
        availableTools: tools.map((tool) => tool.name),
      }),
      tools,
      toolExecutor: toolExecutor.execute,
    };
  } catch {
    return undefined;
  }
}

async function runInteractiveAgentTurn(
  runtime: ResolvedAgentRuntime,
  request: {
    input: string;
    provider: 'auto' | 'shared-llm' | 'decentralized-llm' | 'local-fallback' | 'ollama';
    model?: string;
    strategy?: 'default' | 'latency-aware';
  },
): Promise<{
  id: string;
  providerUsed: string;
  modelUsed?: string;
  output: string;
  timingMs: number;
}> {
  const result = await runChatTurn(
    {
      provider: runtime.chatProvider,
      model: request.model,
      systemPrompt: runtime.systemPrompt,
      tools: runtime.tools,
      toolExecutor: runtime.toolExecutor,
      messages: [],
    },
    request.input,
  );

  return {
    id: `agent_${Date.now().toString(36)}`,
    providerUsed: result.provider,
    modelUsed: result.model,
    output: result.output,
    timingMs: result.timingMs,
  };
}
