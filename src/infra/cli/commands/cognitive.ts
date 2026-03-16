import { categorizeWithV5Context } from '../../../cognitive/categorizer.js';
import { ConnectionDiscovery } from '../../../cognitive/connection-discovery.js';
import { InsightGenerator } from '../../../cognitive/insight-generator.js';
import { KnowledgeSynthesizer } from '../../../cognitive/knowledge-synthesizer.js';
import { getLearningStorage } from '../../../cognitive/learning.js';
import { ProactiveSuggestionEngine } from '../../../cognitive/proactive-suggestions.js';
import { ReflectionEngine } from '../../../reflection/engine.js';
import type { Reflection } from '../../../reflection/types.js';
import { appendBlock, type AppendBlockResult } from '../../storage/chain-adapter.js';
import type { CliContext } from '../context.js';
import { loadCognitiveBlocks } from '../utils/cognitive.js';
import { print } from '../utils/render.js';

type CognitiveHandler = (context: CliContext) => Promise<boolean>;
type InsightWindow = 'daily' | 'weekly' | 'topic';
const COGNITIVE_REPORT_SCHEMA_VERSION = 1;

function summarizeInsights(
  insights: Awaited<ReturnType<InsightGenerator['generateDailyInsights']>>,
): Array<{
  type: string;
  title: string;
  confidence: number;
  actionable: boolean;
  actions: string[];
  evidenceCount: number;
}> {
  return insights.slice(0, 10).map((item) => ({
    type: item.type,
    title: item.title,
    confidence: item.confidence,
    actionable: item.actionable,
    actions: item.actions ?? [],
    evidenceCount: item.evidence.length,
  }));
}

function buildInsightSavePayload(
  window: InsightWindow,
  insights: Awaited<ReturnType<InsightGenerator['generateDailyInsights']>>,
  topic: string | undefined,
): Record<string, unknown> {
  const summary = `${insights.length} insight(s) generated for ${window}${topic ? `:${topic}` : ''}`;
  return {
    type: 'insight_report',
    schemaVersion: COGNITIVE_REPORT_SCHEMA_VERSION,
    source: 'cli.insights',
    content: `Insight Report: ${summary}`,
    tags: ['insight', 'report', window, ...(topic ? [topic] : [])],
    report: {
      generatedAt: new Date().toISOString(),
      window,
      topic,
      count: insights.length,
      insights: summarizeInsights(insights),
    },
  };
}

async function saveInsightsReport(
  window: InsightWindow,
  insights: Awaited<ReturnType<InsightGenerator['generateDailyInsights']>>,
  topic: string | undefined,
): Promise<AppendBlockResult> {
  return appendBlock('journal', buildInsightSavePayload(window, insights, topic), process.env);
}

function serializeReflection(reflection: Reflection): Record<string, unknown> {
  return {
    ...reflection,
    context: Object.fromEntries(reflection.context.entries()),
    timestamp: reflection.timestamp.toISOString(),
  };
}

function buildReflectionSavePayload(reflections: Reflection[]): Record<string, unknown> {
  return {
    type: 'reflection_report',
    schemaVersion: COGNITIVE_REPORT_SCHEMA_VERSION,
    source: 'cli.reflect',
    content: `Reflection Report: ${reflections.length} reflection(s) generated`,
    tags: ['reflection', 'report', 'daily'],
    report: {
      generatedAt: new Date().toISOString(),
      count: reflections.length,
      reflections: reflections.slice(0, 20).map((item) => serializeReflection(item)),
    },
  };
}

async function saveReflectionReport(reflections: Reflection[]): Promise<AppendBlockResult> {
  return appendBlock('journal', buildReflectionSavePayload(reflections), process.env);
}

function buildCategorizeSavePayload(
  input: string,
  suggestion: Awaited<ReturnType<typeof categorizeWithV5Context>>,
): Record<string, unknown> {
  return {
    type: 'categorize_report',
    schemaVersion: COGNITIVE_REPORT_SCHEMA_VERSION,
    source: 'cli.categorize',
    content: `Categorize Report: ${suggestion.tags.length} tag(s) suggested for input`,
    tags: ['categorize', 'report'],
    report: {
      generatedAt: new Date().toISOString(),
      input,
      suggestion,
    },
  };
}

async function saveCategorizeReport(
  input: string,
  suggestion: Awaited<ReturnType<typeof categorizeWithV5Context>>,
): Promise<AppendBlockResult> {
  return appendBlock('journal', buildCategorizeSavePayload(input, suggestion), process.env);
}

export async function handleCognitiveCommand(context: CliContext): Promise<boolean> {
  const command = context.args.command;
  const handlers: Partial<Record<string, CognitiveHandler>> = {
    learn: handleLearnCommand,
    insight: handleInsightsCommand,
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
  const { json, input, query, subcommand, save } = args;
  const generator = new InsightGenerator(await loadCognitiveBlocks());
  const topic = input ?? query;
  const window: InsightWindow = topic
    ? 'topic'
    : subcommand === '--weekly' || argv.includes('--weekly')
      ? 'weekly'
      : 'daily';
  const insights =
    window === 'topic'
      ? await generator.generateTopicInsights(topic ?? 'unknown')
      : window === 'weekly'
        ? await generator.generateWeeklyInsights()
        : await generator.generateDailyInsights();
  const savedBlock = save ? await saveInsightsReport(window, insights, topic) : null;

  if (json) {
    print(
      {
        ok: true,
        mode: 'insights',
        window,
        count: insights.length,
        insights,
        saved: Boolean(savedBlock),
        savedBlock,
      },
      true,
    );
    return true;
  }

  for (const item of insights) {
    console.log(`• [${item.type}] ${item.title} (${Math.round(item.confidence * 100)}%)`);
    console.log(`  ${item.description}`);
  }
  if (savedBlock) {
    console.log(`💾 Saved insight report to ${savedBlock.chain}#${savedBlock.index}`);
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
  const suggestion = await categorizeWithV5Context(subcommand);
  const savedBlock = save ? await saveCategorizeReport(subcommand, suggestion) : null;
  print(
    {
      ok: true,
      mode: 'categorize',
      input: subcommand,
      suggestion,
      saved: Boolean(savedBlock),
      savedBlock,
    },
    json,
  );
  return true;
}

async function handleReflectCommand(context: CliContext): Promise<boolean> {
  const { json, save } = context.args;
  const reflections = await new ReflectionEngine().reflectDaily('manual', new Map());
  const renderedReflections = reflections.map((item) => serializeReflection(item));
  const savedBlock = save ? await saveReflectionReport(reflections) : null;
  print(
    {
      ok: true,
      mode: 'reflect',
      count: reflections.length,
      reflections: renderedReflections,
      saved: Boolean(savedBlock),
      savedBlock,
    },
    json,
  );
  return true;
}
