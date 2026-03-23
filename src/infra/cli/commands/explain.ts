/**
 * `memphis explain [query]` — query the case chain and chain blocks for operator insight.
 *
 * Usage:
 *   memphis explain "what happened with the last evolution?"
 *   memphis explain --chain journal --limit 10
 *   memphis explain --case-type nominative --entity user
 */

import type { CaseType } from '../../../memory/case-types.js';
import { CaseChainAdapter } from '../../storage/case-chain-adapter.js';
import { getRecentBlocks } from '../../storage/rust-chain-adapter.js';
import type { CliContext } from '../context.js';

export async function handleExplainCommand(context: CliContext): Promise<boolean> {
  const { args } = context;
  const query = args.value ?? args.target ?? '';
  const chain = args.key ?? 'journal';
  const limit = 20;

  const output = process.stdout;

  // If --case-type is provided, query the case chain
  const caseType = (args as Record<string, unknown>).caseType as string | undefined;
  const entity = (args as Record<string, unknown>).entity as string | undefined;

  if (caseType || entity) {
    return explainCases(output, { caseType: caseType as CaseType | undefined, entity, limit });
  }

  // Default: query recent chain blocks and summarize
  return explainChain(output, { chain, query, limit });
}

async function explainChain(
  output: NodeJS.WriteStream,
  opts: { chain: string; query: string; limit: number },
): Promise<boolean> {
  const blocks = await getRecentBlocks(opts.chain, opts.limit);

  if (blocks.length === 0) {
    output.write(`No blocks found in chain "${opts.chain}".\n`);
    return true;
  }

  output.write(`\n  Chain: ${opts.chain} (${blocks.length} recent blocks)\n\n`);

  for (const block of blocks) {
    const ts = block.timestamp ?? '?';
    const type = block.data?.type ?? 'unknown';
    const content = block.data?.content ?? '';
    const tags = block.data?.tags ?? [];
    const preview =
      typeof content === 'string' ? content.slice(0, 120) : JSON.stringify(content).slice(0, 120);

    // Filter by query if provided
    if (opts.query) {
      const haystack = `${type} ${preview} ${(tags as string[]).join(' ')}`.toLowerCase();
      if (!haystack.includes(opts.query.toLowerCase())) continue;
    }

    output.write(`  [${ts}] ${type}\n`);
    if (preview) output.write(`    ${preview}\n`);
    if ((tags as string[]).length > 0) output.write(`    tags: ${(tags as string[]).join(', ')}\n`);
    output.write('\n');
  }

  return true;
}

async function explainCases(
  output: NodeJS.WriteStream,
  opts: { caseType?: CaseType; entity?: string; limit: number },
): Promise<boolean> {
  const adapter = new CaseChainAdapter();

  try {
    const result = await adapter.queryCases({
      case_type: opts.caseType,
      entity: opts.entity,
      limit: opts.limit,
    });

    if (result.entries.length === 0) {
      output.write('No case entries found matching the query.\n');
      return true;
    }

    output.write(`\n  Case entries: ${result.entries.length} results\n\n`);

    for (const entry of result.entries) {
      const ts = entry.entry_timestamp ?? '?';
      const caseType = entry.case_type ?? 'unknown';
      const entityVal = entry.entity ?? '';
      output.write(`  [${ts}] ${caseType}: ${entityVal}\n`);
      if (entry.actor) output.write(`    actor: ${entry.actor}\n`);
      if (entry.target) output.write(`    target: ${entry.target}\n`);
      output.write('\n');
    }

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output.write(`Case query failed: ${msg}\n`);
    return true;
  }
}
