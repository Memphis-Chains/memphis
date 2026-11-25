/**
 * `memphis explain [query]` — query the case chain and chain blocks for operator insight.
 *
 * Usage:
 *   memphis explain "what happened with the last evolution?"
 *   memphis explain --chain journal --limit 10
 *   memphis explain --case-type nominative --entity user
 */

import type { CaseEntry, CaseType } from '../../../memory/case-types.js';
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

    for (const row of result.entries) {
      // The row carries the case itself under `entry` — MEASURED 2026-11-24
      // on the built bridge: the wire sends six keys, and the entry is one
      // of them. This command used to read `entry.entity` and
      // `entry_timestamp` off the ROW, which the Rust path never sent, so
      // it printed an empty entity and a `?` for every row.
      //
      // And then it read `entry.entity` off the ENTRY — which only the
      // NOMINATIVE carries. MEASURED 2026-11-24: the eight cases have
      // eight different field sets, and `entity` and `timestamp` belong to
      // the nominative alone. So the other seven cases printed an empty
      // entity and a `?`. The type said so and nothing listened: the
      // union was a flat one, so every field was optional on every case.
      //
      // The entry is a DISCRIMINATED UNION now — the owner's per-variant
      // shape — so the compiler says which fields belong to which case,
      // and the rendering below is checked against the owner instead of
      // against a hand-written list of guesses.
      const described = describeCase(row.entry);
      const stamp = described.stamp || `#${row.block_index}`;
      output.write(`  [${stamp}] ${row.entry.case_type}: ${described.primary}\n`);
      for (const detail of described.details) {
        output.write(`    ${detail}\n`);
      }
      output.write('\n');
    }

    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    output.write(`Case query failed: ${msg}\n`);
    return true;
  }
}

/**
 * One case entry, as the operator reads it: the case's OWN fields.
 *
 * The eight cases carry eight different field sets, so there is no
 * single "entity" to print — MEASURED 2026-11-24 on this host:
 *
 * | case | the keys the wire carries |
 * | --- | --- |
 * | `nominative` | `case_type`, `entity`, `action`, `timestamp` |
 * | `genitive` | `case_type`, `owner`, `possessed` |
 * | `dative` | `case_type`, `giver`, `recipient`, `object` |
 * | `accusative` | `case_type`, `subject`, `verb`, `object` |
 * | `instrumental` | `case_type`, `actor`, `instrument`, `target` |
 * | `locative` | `case_type`, `entity`, `location` |
 * | `ablative` | `case_type`, `entity`, `origin`, `destination` |
 * | `vocative` | `case_type`, `invoker`, `invocation`, `target` |
 *
 * The `primary` is the case's own subject — `owner` for a genitive,
 * `giver` for a dative, `invoker` for a vocative — because a genitive
 * has no `entity` and printing an empty one told the operator nothing.
 *
 * `stamp` is the timestamp, and only the NOMINATIVE carries one: the
 * other seven have none on the wire, and the row's block index says
 * which entry it is.
 */
function describeCase(entry: CaseEntry): { stamp: string; primary: string; details: string[] } {
  switch (entry.case_type) {
    case 'nominative':
      return {
        stamp: entry.timestamp,
        primary: entry.entity,
        details: [`action: ${entry.action}`],
      };
    case 'genitive':
      return { stamp: '', primary: entry.owner, details: [`possessed: ${entry.possessed}`] };
    case 'dative':
      return {
        stamp: '',
        primary: entry.giver,
        details: [`recipient: ${entry.recipient}`, `object: ${entry.object}`],
      };
    case 'accusative':
      return {
        stamp: '',
        primary: entry.subject,
        details: [`verb: ${entry.verb}`, `object: ${entry.object}`],
      };
    case 'instrumental':
      return {
        stamp: '',
        primary: entry.actor,
        details: [`instrument: ${entry.instrument}`, `target: ${entry.target}`],
      };
    case 'locative':
      return { stamp: '', primary: entry.entity, details: [`location: ${entry.location}`] };
    case 'ablative':
      return {
        stamp: '',
        primary: entry.entity,
        details: [
          `origin: ${entry.origin}`,
          // `destination` is ABSENT when the ablative has none — it is
          // an `Option` with `skip_serializing_if`, not a null.
          ...(entry.destination === undefined ? [] : [`destination: ${entry.destination}`]),
        ],
      };
    case 'vocative':
      return {
        stamp: '',
        primary: entry.invoker,
        details: [`invocation: ${entry.invocation}`, `target: ${entry.target}`],
      };
    default:
      // Exhaustive check — the union is the owner's, and a case the owner
      // does not have cannot arrive here.
      throw new Error(`Unknown case_type: ${(entry as { case_type?: string }).case_type}`);
  }
}
