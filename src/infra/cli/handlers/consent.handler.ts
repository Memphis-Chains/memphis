import { appendBlock } from '../../storage/chain-adapter.js';
import { getRecentBlocks } from '../../storage/rust-chain-adapter.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';
import { print } from '../utils/render.js';

type ConsentLevel = 'exportable' | 'local-only' | 'anonymized';

function parseConsentLevel(raw: string | undefined): ConsentLevel {
  if (raw === 'exportable' || raw === 'local-only' || raw === 'anonymized') {
    return raw;
  }
  throw new Error(
    `--level must be one of exportable|local-only|anonymized; got ${JSON.stringify(raw)}`,
  );
}

export const consentCommandHandler: CommandHandler = {
  name: 'consent',
  commands: ['consent'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'consent';
  },
  async handle(context: CliContext): Promise<boolean> {
    const { subcommand } = context.args;
    if (subcommand === 'mark') {
      return handleConsentMark(context);
    }
    throw new Error(`Unknown consent subcommand: ${String(subcommand)}. Available: mark.`);
  },
};

/**
 * `memphis consent mark --chain <name> --from-index <n> --level <exportable|local-only|anonymized>`
 *
 * Retroactive consent-level utility for operators who had blocks
 * written pre-N8 (no consent stamped) or with the wrong consent level.
 * Chains are append-only, so we don't rewrite existing blocks; instead
 * we append a single `consent.annotation` block to the journal chain
 * that downstream consumers (trajectory exporter, recall filters) will
 * use to override the effective consent on the target range.
 *
 * Honors `--dry-run` to preview without appending. Writes are audited
 * through the normal chain-adapter path.
 */
async function handleConsentMark(context: CliContext): Promise<boolean> {
  const { chain, id } = context.args;
  const fromIndexRaw = context.args.fromIndex;
  const level = parseConsentLevel(context.args.level);
  const targetChain = (chain ?? id ?? '').trim();
  if (!targetChain) {
    throw new Error('consent mark requires --chain <name>');
  }
  if (typeof fromIndexRaw !== 'number' || !Number.isFinite(fromIndexRaw) || fromIndexRaw < 0) {
    throw new Error('consent mark requires --from-index <non-negative integer>');
  }
  const fromIndex = Math.floor(fromIndexRaw);

  // Inspect the target chain to confirm the from-index exists. Avoids
  // silently creating annotations that cover zero blocks because the
  // operator typo'd the index.
  const blocks = await getRecentBlocks(targetChain, 100000, process.env);
  const lastIndex = blocks.length > 0 ? blocks[blocks.length - 1].index ?? -1 : -1;
  if (lastIndex < 0) {
    throw new Error(`consent mark: chain '${targetChain}' is empty or missing`);
  }
  if (fromIndex > lastIndex) {
    throw new Error(
      `consent mark: --from-index ${fromIndex} is past the tip of '${targetChain}' (last index: ${lastIndex})`,
    );
  }
  const toIndex = lastIndex;

  const annotationPayload = {
    type: 'consent.annotation',
    target_chain: targetChain,
    from_index: fromIndex,
    to_index: toIndex,
    level,
    // Explicit provenance so downstream consumers can distinguish
    // retroactive tooling writes from in-turn consent stamps.
    source: 'cli.consent-mark',
    issued_at: new Date().toISOString(),
  };

  if (context.args.dryRun) {
    print(
      {
        ok: true,
        mode: 'consent.mark.dry-run',
        annotation: annotationPayload,
        blocksAffected: toIndex - fromIndex + 1,
      },
      context.args.json,
    );
    return true;
  }

  const block = await appendBlock('journal', annotationPayload);
  print(
    {
      ok: true,
      mode: 'consent.mark',
      annotation: annotationPayload,
      block: { chain: 'journal', index: block.index, hash: block.hash },
      blocksAffected: toIndex - fromIndex + 1,
    },
    context.args.json,
  );
  return true;
}
