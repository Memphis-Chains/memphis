import { categorizeWithV5Context } from '../../../cognitive/categorizer.js';
import { ConnectionDiscovery } from '../../../cognitive/connection-discovery.js';
import { InsightGenerator } from '../../../cognitive/insight-generator.js';
import { KnowledgeSynthesizer } from '../../../cognitive/knowledge-synthesizer.js';
import { getLearningStorage } from '../../../cognitive/learning.js';
import { ProactiveSuggestionEngine } from '../../../cognitive/proactive-suggestions.js';
import { loadCognitiveBlocks } from '../../../cognitive/runtime-support.js';
import { runMemphisClassify, type MemphisClassifyInput } from '../../../mcp/tools/classify.js';
import { ReflectionEngine } from '../../../reflection/engine.js';
import type { Reflection } from '../../../reflection/types.js';
import { appendBlock, type AppendBlockResult } from '../../storage/chain-adapter.js';
import type { CliContext } from '../context.js';
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
  // Canonical envelope: `type` is the Rust BlockType variant accepted
  // by the journal chain (chain-catalog: journal → ['journal','insight']),
  // `kind` is the discriminator. The previous shape used `type:
  // 'insight_report'` directly, which wasn't a valid BlockType and made
  // the journal write inconsistent with categorize/reflect handlers
  // (both already used `{type:'insight', kind:'*_report'}`). Aligned
  // 2026-05-08 during the post-Zawoja envelope sweep.
  return {
    type: 'insight',
    kind: 'insight_report',
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
    type: 'insight',
    kind: 'reflection_report',
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

export async function generateInsightsCommandData(options: {
  argv?: string[];
  input?: string;
  query?: string;
  subcommand?: string;
  save?: boolean;
}): Promise<{
  ok: true;
  mode: 'insights';
  window: InsightWindow;
  count: number;
  insights: Awaited<ReturnType<InsightGenerator['generateDailyInsights']>>;
  saved: boolean;
  savedBlock: AppendBlockResult | null;
}> {
  const argv = options.argv ?? [];
  const topic = options.input ?? options.query;
  const window: InsightWindow = topic
    ? 'topic'
    : options.subcommand === '--weekly' || argv.includes('--weekly')
      ? 'weekly'
      : 'daily';
  const generator = new InsightGenerator(await loadCognitiveBlocks());
  const insights =
    window === 'topic'
      ? await generator.generateTopicInsights(topic ?? 'unknown')
      : window === 'weekly'
        ? await generator.generateWeeklyInsights()
        : await generator.generateDailyInsights();
  const savedBlock = options.save ? await saveInsightsReport(window, insights, topic) : null;

  return {
    ok: true,
    mode: 'insights',
    window,
    count: insights.length,
    insights,
    saved: Boolean(savedBlock),
    savedBlock,
  };
}

export async function generateReflectCommandData(
  options: {
    save?: boolean;
  } = {},
): Promise<{
  ok: true;
  mode: 'reflect';
  count: number;
  reflections: Record<string, unknown>[];
  saved: boolean;
  savedBlock: AppendBlockResult | null;
}> {
  const reflections = await new ReflectionEngine().reflectDaily('manual', new Map());
  const renderedReflections = reflections.map((item) => serializeReflection(item));
  const savedBlock = options.save ? await saveReflectionReport(reflections) : null;

  return {
    ok: true,
    mode: 'reflect',
    count: reflections.length,
    reflections: renderedReflections,
    saved: Boolean(savedBlock),
    savedBlock,
  };
}

function buildCategorizeSavePayload(
  input: string,
  suggestion: Awaited<ReturnType<typeof categorizeWithV5Context>>,
): Record<string, unknown> {
  return {
    type: 'insight',
    kind: 'categorize_report',
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
    classify: handleClassifyCommand,
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
  const result = await generateInsightsCommandData({ argv, input, query, subcommand, save });

  if (json) {
    print(result, true);
    return true;
  }

  for (const item of result.insights) {
    console.log(`• [${item.type}] ${item.title} (${Math.round(item.confidence * 100)}%)`);
    console.log(`  ${item.description}`);
  }
  if (result.savedBlock) {
    console.log(`💾 Saved insight report to ${result.savedBlock.chain}#${result.savedBlock.index}`);
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
  // Extract positional topics from argv - skip ['memphis', 'connections', 'find']
  // and collect all non-flag arguments that follow
  const cmdIndex = argv.indexOf('find');
  const positionalTopics =
    cmdIndex >= 0 ? argv.slice(cmdIndex + 1).filter((arg) => !arg.startsWith('--')) : [];

  let topicA = positionalTopics[0];
  let topicB = positionalTopics[1];

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

/**
 * `memphis classify` — CLI surface over `memphis_classify` (BASAL typed
 * decisions). The tool existed only on the MCP/native surfaces, so
 * `memphis classify --state ...` printed help (journal-670, 2026-10-03):
 * registry `cliFlags` are not CLI arguments.
 *
 * Criteria arrive as one string so the command stays shell-friendly:
 *   --criteria 'karta:Rzeki kredytowe,kredyt:Pożyczki gotówkowe'
 * A bare `karta,kredyt` is accepted too and the options double as keys.
 *
 * SLOW on this host (~70 s at orders=1, ~140 s at orders=2) — it blocks on
 * the BASAL service, not on local CPU work.
 */
async function handleClassifyCommand(context: CliContext): Promise<boolean> {
  const { json } = context.args;
  const raw = readClassifyFlag(context.argv, '--state');
  const question = readClassifyFlag(context.argv, '--question');
  const criteriaRaw = readClassifyFlag(context.argv, '--criteria');
  const type = readClassifyFlag(context.argv, '--type');
  const ordersRaw = readClassifyFlag(context.argv, '--orders');
  const thresholdRaw = readClassifyFlag(context.argv, '--threshold');

  if (!raw) throw new Error('classify requires --state "text to classify"');
  if (!question) throw new Error('classify requires --question "what to decide"');
  if (!criteriaRaw)
    throw new Error('classify requires --criteria "key:description,key2:description2"');

  const criteria: Record<string, string> = {};
  for (const pair of criteriaRaw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(':');
    if (sep === -1) criteria[trimmed] = trimmed;
    else {
      const key = trimmed.slice(0, sep).trim();
      if (key) criteria[key] = trimmed.slice(sep + 1).trim() || key;
    }
  }
  const optionCount = Object.keys(criteria).length;
  if (optionCount < 2)
    throw new Error(`classify requires at least two criteria options; got ${optionCount}`);
  if (optionCount > 10) throw new Error(`classify supports at most 10 options, got ${optionCount}`);

  const input: MemphisClassifyInput = {
    state: raw,
    question,
    criteria,
    type: type === 'noul' || type === 'score' || type === 'choice' ? type : undefined,
    orders: ordersRaw === '2' ? 2 : ordersRaw === '1' ? 1 : undefined,
    threshold: thresholdRaw ? Number(thresholdRaw) : undefined,
  };

  print({ ok: true, mode: 'classify', input, result: await runMemphisClassify(input) }, json);
  return true;
}

/** Read `--flag value` straight off argv: classify args are not CliArgs fields. */
function readClassifyFlag(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? undefined : value;
}

async function handleReflectCommand(context: CliContext): Promise<boolean> {
  const { json, save } = context.args;
  print(await generateReflectCommandData({ save }), json);
  return true;
}
