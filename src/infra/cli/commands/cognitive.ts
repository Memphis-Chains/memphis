import { ReflectionEngine } from '../../../reflection/engine.js';
import { categorizeWithV5Context } from '../../../cognitive/categorizer.js';
import { getLearningStorage } from '../../../cognitive/learning.js';
import { InsightGenerator } from '../../../cognitive/insight-generator.js';
import { ConnectionDiscovery } from '../../../cognitive/connection-discovery.js';
import { KnowledgeSynthesizer } from '../../../cognitive/knowledge-synthesizer.js';
import { ProactiveSuggestionEngine } from '../../../cognitive/proactive-suggestions.js';
import { loadCognitiveBlocks } from '../utils/cognitive.js';
import { print } from '../utils/render.js';
import type { CliContext } from '../context.js';

export async function handleCognitiveCommand(context: CliContext): Promise<boolean> {
  const { argv, args } = context;
  const { command, subcommand, json, reset, input, query, save } = args;

  if (command === 'learn') {
    const storage = getLearningStorage();
    if (reset) storage.clear();
    print({ ok: true, mode: 'learn', reset, stats: storage.getStats() }, json);
    return true;
  }

  if (command === 'insights') {
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

  if (command === 'connections') {
    const loaded = await loadCognitiveBlocks();
    const discovery = new ConnectionDiscovery(loaded);

    if (subcommand === 'scan') {
      const connections = await discovery.scanForConnections();
      print({ ok: true, mode: 'connections-scan', count: connections.length, connections }, json);
      return true;
    }

    if (subcommand === 'find') {
      const positionalA = argv[4];
      const positionalB = argv[5];
      const raw = query ?? input;

      let topicA = positionalA;
      let topicB = positionalB;

      if ((!topicA || !topicB) && raw && raw.includes(',')) {
        [topicA, topicB] = raw.split(',').map((s) => s.trim());
      }

      if (!topicA || !topicB) throw new Error('connections find requires positional topics: connections find "AI" "blockchain" (or --query "AI,blockchain")');
      const found = await new KnowledgeSynthesizer(loaded).findConnections(topicA, topicB);
      print({ ok: true, mode: 'connections-find', topics: [topicA, topicB], found }, json);
      return true;
    }

    throw new Error(`Unknown connections subcommand: ${String(subcommand)}`);
  }

  if (command === 'suggest') {
    print({ ok: true, mode: 'suggest', suggestions: await new ProactiveSuggestionEngine(await loadCognitiveBlocks()).generateSuggestions() }, json);
    return true;
  }

  if (command === 'categorize') {
    const text = subcommand;
    if (!text) throw new Error('categorize requires text argument: memphis categorize "your text"');
    print(
      {
        ok: true,
        mode: 'categorize',
        input: text,
        suggestion: await categorizeWithV5Context(text),
        saved: save,
        message: save ? 'save requested; journal persistence is not implemented yet' : undefined,
      },
      json,
    );
    return true;
  }

  if (command === 'reflect') {
    const reflections = await new ReflectionEngine().reflectDaily('manual', new Map());
    print(
      {
        ok: true,
        mode: 'reflect',
        count: reflections.length,
        reflections: reflections.map((item) => ({ ...item, context: Object.fromEntries(item.context.entries()) })),
        saved: save,
        message: save ? 'save requested; chain persistence is not implemented yet' : undefined,
      },
      json,
    );
    return true;
  }

  return false;
}
