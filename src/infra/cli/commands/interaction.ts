import { AskSession } from '../../../cli/ask-session.js';
import { runMemphisDecide } from '../../../mcp/tools/decide.js';
import { runMemphisExec } from '../../../mcp/tools/exec.js';
import { runMemphisHealth } from '../../../mcp/tools/health.js';
import { runMemphisJournal } from '../../../mcp/tools/journal.js';
import { runMemphisRecall } from '../../../mcp/tools/recall.js';
import { runMemphisWebFetch } from '../../../mcp/tools/web-fetch.js';
import type { ChatToolCall, ChatToolDefinition } from '../../../providers/index.js';
import { resolveProvider, defaultProviderConfig } from '../../../providers/index.js';
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

const MCP_TOOLS: ChatToolDefinition[] = [
  {
    name: 'memphis_journal',
    description: 'Save an entry to the Memphis journal chain',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Content to journal' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
      },
      required: ['content'],
    },
  },
  {
    name: 'memphis_recall',
    description: 'Semantic search across Memphis memory chains',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (1-50)', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'memphis_decide',
    description: 'Record a decision with context',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        choice: { type: 'string' },
        context: { type: 'string' },
      },
      required: ['title', 'choice'],
    },
  },
  {
    name: 'memphis_health',
    description: 'Check Memphis runtime health',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memphis_web_fetch',
    description: 'Fetch a public URL',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to fetch' } },
      required: ['url'],
    },
  },
  {
    name: 'memphis_exec',
    description: 'Execute an allowlisted command (echo, pwd, ls, whoami, date, uptime)',
    inputSchema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'Command to execute' } },
      required: ['command'],
    },
  },
];

async function executeTool(call: ChatToolCall): Promise<string> {
  const args = call.arguments;
  switch (call.name) {
    case 'memphis_journal':
      return JSON.stringify(await runMemphisJournal({ content: args.content as string, tags: args.tags as string[] | undefined }));
    case 'memphis_recall':
      return JSON.stringify(runMemphisRecall({ query: args.query as string, limit: (args.limit as number) ?? 5 }));
    case 'memphis_decide':
      return JSON.stringify(await runMemphisDecide({ title: args.title as string, choice: args.choice as string, context: args.context as string | undefined }));
    case 'memphis_health':
      return JSON.stringify(await runMemphisHealth());
    case 'memphis_web_fetch':
      return JSON.stringify(await runMemphisWebFetch({ url: args.url as string }));
    case 'memphis_exec':
      return JSON.stringify(runMemphisExec({ command: args.command as string }));
    default:
      return JSON.stringify({ error: `unknown tool: ${call.name}` });
  }
}

async function handleTuiCommand(context: CliContext): Promise<boolean> {
  const { provider, model, strategy } = context.args;

  // Resolve a real chat provider (Provider.chat interface)
  let chatProvider;
  try {
    chatProvider = await resolveProvider(defaultProviderConfig());
  } catch {
    // No chat provider available — TUI will use orchestration fallback
  }

  await runTuiApp({
    orchestration: context.getContainer().orchestration,
    provider: provider ?? 'auto',
    model,
    strategy,
    chatProvider: chatProvider ?? undefined,
    systemPrompt: process.env.GATEWAY_SYSTEM_PROMPT || process.env.OPENCLAW_SYSTEM_PROMPT,
    tools: chatProvider ? MCP_TOOLS : undefined,
    toolExecutor: chatProvider ? executeTool : undefined,
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
