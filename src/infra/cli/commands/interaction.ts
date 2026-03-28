import type { ProviderName } from '../../../core/types.js';
import { buildRuntimeSystemPrompt } from '../../../gateway/agent-runtime.js';
import { createInProcessMemoryClient } from '../../../gateway/memory-client.js';
import { createInProcessToolExecutor } from '../../../gateway/tool-executor.js';
import type { InProcessToolExecutorDeps } from '../../../gateway/tool-executor.js';
import { CaseChainAdapter } from '../../../infra/storage/case-chain-adapter.js';
import type { OrchestrationService } from '../../../modules/orchestration/service.js';
import type { RuntimeProvider } from '../../../providers/runtime.js';
import { runChatTurn } from '../chat-turn.js';
import type { CliContext } from '../context.js';
import { runInteractiveChat } from '../interactive-chat.js';
import { runRustTui } from './rust-tui.js';
import { runTuiHost } from '../../tui-host/index.js';
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
  const { session, input, provider, model, strategy, json, tui, systemPrompt } = context.args;
  const runtime = await resolveAgentRuntime({
    orchestration: context.getContainer().orchestration,
    requestedProvider: provider ?? 'auto',
    strategy,
    systemPrompt,
    toolExecutorDeps: {
      evolveSessionRepository: context.getContainer().evolveSessionRepository,
      caseAdapter: new CaseChainAdapter(process.env),
      projectRoot: process.cwd(),
    },
  });
  if (!runtime) {
    throw new Error('ask-session requires a runtime provider');
  }

  const resolvedSession = session?.trim() || 'default';
  const askRuntime = { ...runtime, userId: `cli:ask-session:${resolvedSession}` };
  const askSessionRuntime = {
    provider: askRuntime.chatProvider,
    memory: askRuntime.memory,
    userId: askRuntime.userId,
    model,
    systemPrompt: askRuntime.systemPrompt,
    tools: askRuntime.tools,
    toolExecutor: askRuntime.toolExecutor,
  };

  if (input && input.trim().length > 0) {
    await runAskSessionTurn({
      session: resolvedSession,
      rawInput: input,
      runtime: askSessionRuntime,
      json,
      tui,
    });
    return true;
  }

  await runAskSessionInteractive({
    session: resolvedSession,
    runtime: askSessionRuntime,
    json,
    tui,
    provider: provider ?? 'auto',
    model,
    strategy,
  });
  return true;
}

async function handleProvidersHealthCommand(context: CliContext): Promise<boolean> {
  const config = context.getConfig();
  const providers = await context.getContainer().orchestration.providersHealth();
  print({ defaultProvider: config.DEFAULT_PROVIDER, providers }, context.args.json);
  return true;
}

async function handleTuiCommand(context: CliContext): Promise<boolean> {
  if (context.args.subcommand === 'host') {
    await runTuiHost(context);
    return true;
  }
  await runRustTui(context);
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
    provider: 'auto' | ProviderName;
    model?: string;
    strategy?: 'default' | 'latency-aware';
  },
  json: boolean,
  tui: boolean,
): Promise<void> {
  const runtime = await resolveAgentRuntime({
    orchestration: context.getContainer().orchestration,
    requestedProvider: request.provider,
    strategy: request.strategy,
    systemPrompt: context.args.systemPrompt,
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
  const runtime = await resolveAgentRuntime({
    orchestration: context.getContainer().orchestration,
    requestedProvider: provider ?? 'auto',
    strategy,
    systemPrompt: context.args.systemPrompt,
    toolExecutorDeps: {
      evolveSessionRepository: context.getContainer().evolveSessionRepository,
      caseAdapter: new CaseChainAdapter(process.env),
      projectRoot: process.cwd(),
    },
  });
  if (!runtime) {
    throw new Error('ask --session requires a runtime provider');
  }
  const askRuntime = { ...runtime, userId: `cli:ask-session:${session}` };
  const askSessionRuntime = {
    provider: askRuntime.chatProvider,
    memory: askRuntime.memory,
    userId: askRuntime.userId,
    model,
    systemPrompt: askRuntime.systemPrompt,
    tools: askRuntime.tools,
    toolExecutor: askRuntime.toolExecutor,
  };

  if (interactive && (!input || input.trim().length === 0)) {
    await runAskSessionInteractive({
      session,
      runtime: askSessionRuntime,
      json,
      tui,
      provider: provider ?? 'auto',
      model,
      strategy,
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
    runtime: askSessionRuntime,
    json,
    tui,
  });
  return true;
}

async function handleInteractiveChat(context: CliContext): Promise<boolean> {
  const { provider, model, strategy, systemPrompt } = context.args;
  const runtime = await resolveAgentRuntime({
    orchestration: context.getContainer().orchestration,
    requestedProvider: provider ?? 'auto',
    strategy,
    systemPrompt,
    toolExecutorDeps: {
      evolveSessionRepository: context.getContainer().evolveSessionRepository,
      caseAdapter: new CaseChainAdapter(process.env),
      projectRoot: process.cwd(),
    },
  });
  await runInteractiveChat({
    orchestration: context.getContainer().orchestration,
    provider: provider ?? 'auto',
    model,
    strategy,
    chatProvider: runtime?.chatProvider,
    memory: runtime?.memory,
    userId: runtime?.userId,
    systemPrompt: runtime?.systemPrompt,
    tools: runtime?.tools,
    toolExecutor: runtime?.toolExecutor,
  });
  return true;
}

type ResolvedAgentRuntime = {
  chatProvider: RuntimeProvider;
  memory: ReturnType<typeof createInProcessMemoryClient>;
  userId: string;
  systemPrompt: string;
  tools: ReturnType<ReturnType<typeof createInProcessToolExecutor>['listTools']>;
  toolExecutor: ReturnType<typeof createInProcessToolExecutor>['execute'];
};

async function resolveAgentRuntime(
  options: {
    orchestration: OrchestrationService;
    requestedProvider?: 'auto' | ProviderName;
    strategy?: 'default' | 'latency-aware';
    systemPrompt?: string;
    toolExecutorDeps?: InProcessToolExecutorDeps;
  },
): Promise<ResolvedAgentRuntime | undefined> {
  try {
    const chatProvider = options.orchestration.resolveRuntimeProvider(
      options.requestedProvider,
      options.strategy,
    );
    const toolExecutor = createInProcessToolExecutor(options.toolExecutorDeps);
    const tools = toolExecutor.listTools();
    return {
      chatProvider,
      memory: createInProcessMemoryClient(),
      userId: 'cli:local',
      systemPrompt: [
        options.systemPrompt?.trim(),
        buildRuntimeSystemPrompt({
          availableTools: tools.map((tool) => tool.name),
        }),
      ]
        .filter(Boolean)
        .join('\n\n'),
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
    provider: 'auto' | ProviderName;
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
      memory: runtime.memory,
      userId: runtime.userId,
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
