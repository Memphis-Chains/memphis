/**
 * Memphis Insight CLI Command
 *
 * Generates AI-powered insights from memory chains
 *
 * @usage memphis insight [--period daily|weekly|deep]
 */

import { InsightGenerator } from '../../cognitive/insight-generator.js';
import { ChainStore, IStore } from '../../cognitive/store.js';
import { getRecentBlocks } from '../../infra/storage/rust-chain-adapter.js';
import type { Block } from '../../memory/chain.js';

export interface InsightCommandOptions {
  period?: 'daily' | 'weekly' | 'deep';
  format?: 'text' | 'json';
  save?: boolean;
}

type PeriodPlan = {
  journal: number;
  decision: number;
  reflections: number;
};

const PERIOD_PLANS: Record<'daily' | 'weekly' | 'deep', PeriodPlan> = {
  daily: { journal: 60, decision: 30, reflections: 20 },
  weekly: { journal: 240, decision: 120, reflections: 80 },
  deep: { journal: 500, decision: 300, reflections: 200 },
};

function normalizePeriod(period: InsightCommandOptions['period']): 'daily' | 'weekly' | 'deep' {
  if (period === 'weekly' || period === 'deep') return period;
  return 'daily';
}

function normalizeFormat(format: InsightCommandOptions['format']): 'text' | 'json' {
  return format === 'json' ? 'json' : 'text';
}

function normalizeSave(save: unknown): boolean {
  if (typeof save === 'boolean') return save;
  if (typeof save === 'string') return save.toLowerCase() === 'true';
  return false;
}

function sortByTimestamp(blocks: Block[]): Block[] {
  return blocks.sort(
    (a, b) => new Date(a.timestamp ?? 0).getTime() - new Date(b.timestamp ?? 0).getTime(),
  );
}

export async function loadBlocksForPeriod(
  period: InsightCommandOptions['period'],
): Promise<Block[]> {
  const plan = PERIOD_PLANS[normalizePeriod(period)];
  const [journal, decision, reflections] = await Promise.all([
    getRecentBlocks('journal', plan.journal),
    getRecentBlocks('decision', plan.decision),
    getRecentBlocks('reflections', plan.reflections),
  ]);

  return sortByTimestamp([...journal, ...decision, ...reflections]);
}

async function persistReportToJournal(
  report: Awaited<ReturnType<InsightGenerator['generate']>>,
  period: 'daily' | 'weekly' | 'deep',
  store: IStore,
): Promise<void> {
  await store.append('journal', {
    type: 'insight-report',
    source: 'insight-command',
    period,
    mood: report.mood,
    summary: report.summary,
    insightCount: report.insights.length,
    quickWins: report.quickWins,
    insights: report.insights,
    generatedAt: report.generated.toISOString(),
    tags: ['insight', 'report', period, report.mood],
  });
}

export async function runInsightCommand(
  blocks: Block[],
  options: InsightCommandOptions = {},
  store: IStore = new ChainStore(),
): Promise<void> {
  const generator = new InsightGenerator(blocks, store);
  const period = normalizePeriod(options.period);
  const format = normalizeFormat(options.format);
  const save = normalizeSave(options.save);

  console.log('');
  console.log('🧠 Memphis Insight Generator');
  console.log('');

  try {
    const report = await generator.generate();

    if (format === 'json') {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(generator.format(report));
    }

    // Save to journal if requested
    if (save) {
      console.log(`Insight Report (${report.mood}): ${report.summary}`);
      console.log('');
      console.log(`💾 Saving to journal...`);
      await persistReportToJournal(report, period, store);
      console.log(`✅ Saved`);
    }
  } catch (error) {
    console.error('❌ Failed to generate insights:', error);
    process.exit(1);
  }
}

/**
 * CLI entry point
 */
export function createInsightCommand(): {
  name: string;
  description: string;
  options: Array<{ name: string; description: string; default?: string }>;
  action: (options: Record<string, unknown>) => Promise<void>;
} {
  return {
    name: 'insight',
    description: 'Generate AI-powered insights from memory chains',
    options: [
      {
        name: 'period',
        description: 'Analysis period (daily, weekly, deep)',
        default: 'daily',
      },
      {
        name: 'format',
        description: 'Output format (text, json)',
        default: 'text',
      },
      {
        name: 'save',
        description: 'Save report to journal',
      },
    ],
    action: async (options) => {
      const normalizedOptions: InsightCommandOptions = {
        period: normalizePeriod(options.period as InsightCommandOptions['period']),
        format: normalizeFormat(options.format as InsightCommandOptions['format']),
        save: normalizeSave(options.save),
      };
      const blocks = await loadBlocksForPeriod(normalizedOptions.period);
      await runInsightCommand(blocks, normalizedOptions);
    },
  };
}
