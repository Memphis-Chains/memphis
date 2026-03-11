/**
 * Memphis Insight CLI Command
 * 
 * Generates AI-powered insights from memory chains
 * 
 * @usage memphis insight [--period daily|weekly|deep]
 */

import type { Block } from '../../memory/chain.js';
import { InsightGenerator } from '../../cognitive/insight-generator.js';

export interface InsightCommandOptions {
  period?: 'daily' | 'weekly' | 'deep';
  format?: 'text' | 'json';
  save?: boolean;
}

export async function runInsightCommand(
  blocks: Block[],
  options: InsightCommandOptions = {}
): Promise<void> {
  const generator = new InsightGenerator(blocks);
  
  console.log('');
  console.log('🧠 Memphis Insight Generator');
  console.log('');

  try {
    const report = await generator.generate();
    
    if (options.format === 'json') {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(generator.format(report));
    }

    // Save to journal if requested
    if (options.save) {
      const summary = `Insight Report (${report.mood}): ${report.summary}`;
      console.log('');
      console.log(`💾 Saving to journal...`);
      // TODO: Implement save to chain
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
  action: (options: Record<string, any>) => Promise<void>;
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
      // Load blocks from chain
      // TODO: Implement actual block loading
      const blocks: Block[] = [];
      await runInsightCommand(blocks, options as InsightCommandOptions);
    },
  };
}
