import { categorizeWithV5Context } from '../../../cognitive/categorizer.js';
import { ConnectionDiscovery } from '../../../cognitive/connection-discovery.js';
import { InsightGenerator } from '../../../cognitive/insight-generator.js';
import { KnowledgeSynthesizer } from '../../../cognitive/knowledge-synthesizer.js';
import { getLearningStorage } from '../../../cognitive/learning.js';
import { ProactiveSuggestionEngine } from '../../../cognitive/proactive-suggestions.js';
import { ReflectionEngine } from '../../../reflection/engine.js';
import type { CliContext } from '../context.js';
import { loadCognitiveBlocks } from '../utils/cognitive.js';
import { print } from '../utils/render.js';

type CognitiveHandler = (context: CliContext) => Promise<boolean>;

export async function handleCognitiveCommand(context: CliContext): Promise<boolean> {
  const command = context.args.command;
  const handlers: Partial<Record<string, CognitiveHandler>> = {
    learn: handleLearnCommand,
    insights: handleInsightsCommand,
    connections: handleConnectionsCommand,
    suggest: handleSuggestCommand,
    categorize: handleCategorizeCommand,
    reflect: handleReflectCommand,
  };
  const handler = command ? handlers[command] : undefined;
  return handler ? handler(context) : false;
}

async function handleLearnCommand(context: CliContext): Promise<boolean> {
  const { json, reset } = context.args;
  const storage = getLearningStorage();
  if (reset) storage.clear();
  print({ ok: true, mode: 'learn', reset, stats: storage.getStats() }, json);
  return true;
}

async function handleInsightsCommand(context: CliContext): Promise<boolean> {
  const { argv, args } = context;
  const { json, input, query, subcommand } = args;
  const generator = new InsightGenerator(await loadCognitiveBlocks());
  const topic = input ?? query;
  const insights = topic
    ? await generator.generateTopicInsights(topic)
    : subcommand === '--weekly' || argv.includes('--weekly')
      ? await generator.generateWeeklyInsights()
      : await generator.generateDailyInsights();

  if (json) {
    print({ ok: true, mode: 'insights', count: insights.length, insights }, true);
    return true;
  }

  for (const item of insights) {
    console.log(`• [${item.type}] ${item.title} (${Math.round(item.confidence * 100)}%)`);
    console.log(`  ${item.description}`);
  }
  return true;
}

async function handleConnectionsCommand(context: CliContext): Promise<boolean> {
  const { argv, args } = context;
  const { json, subcommand, query, input } = args;
  const loaded = await loadCognitiveBlocks();

  if (subcommand === 'scan') {
    const connections = await new ConnectionDiscovery(loaded).scanForConnections();
    print({ ok: true, mode: 'connections-scan', count: connections.length, connections }, json);
    return true;
  }

  if (subcommand !== 'find')
    throw new Error(`Unknown connections subcommand: ${String(subcommand)}`);
  const [topicA, topicB] = resolveConnectionTopics(argv, query ?? input);
  const found = await new KnowledgeSynthesizer(loaded).findConnections(topicA, topicB);
  print({ ok: true, mode: 'connections-find', topics: [topicA, topicB], found }, json);
  return true;
}

function resolveConnectionTopics(argv: string[], raw: string | undefined): [string, string] {
  let topicA = argv[4];
  let topicB = argv[5];
  if ((!topicA || !topicB) && raw?.includes(',')) {
    [topicA, topicB] = raw.split(',').map((s) => s.trim());
  }
  if (!topicA || !topicB)
    throw new Error(
      'connections find requires positional topics: connections find "AI" "blockchain" (or --query "AI,blockchain")',
    );
  return [topicA, topicB];
}

async function handleSuggestCommand(context: CliContext): Promise<boolean> {
  print(
    {
      ok: true,
      mode: 'suggest',
      suggestions: await new ProactiveSuggestionEngine(
        await loadCognitiveBlocks(),
      ).generateSuggestions(),
    },
    context.args.json,
  );
  return true;
}

async function handleCategorizeCommand(context: CliContext): Promise<boolean> {
  const { json, save, subcommand } = context.args;
  if (!subcommand)
    throw new Error('categorize requires text argument: memphis categorize "your text"');
  print(
    {
      ok: true,
      mode: 'categorize',
      input: subcommand,
      suggestion: await categorizeWithV5Context(subcommand),
      saved: save,
      message: save ? 'save requested; journal persistence is not implemented yet' : undefined,
    },
    json,
  );
  return true;
}

async function handleReflectCommand(context: CliContext): Promise<boolean> {
  const { json, save } = context.args;
  const reflections = await new ReflectionEngine().reflectDaily('manual', new Map());
  print(
    {
      ok: true,
      mode: 'reflect',
      count: reflections.length,
      reflections: reflections.map((item) => ({
        ...item,
        context: Object.fromEntries(item.context.entries()),
      })),
      saved: save,
      message: save ? 'save requested; chain persistence is not implemented yet' : undefined,
    },
    json,
  );
  return true;
}
