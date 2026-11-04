/**
 * The block vocabulary, repaired.
 *
 * WHAT THIS IS FOR
 *
 * The native core owns a CLOSED enum of block types
 * (`crates/memphis-core/src/block.rs:5`). It is also the thing that
 * WRITES. A block whose `data.type` is not one of its variants does not
 * deserialize at all — so a chain can hold a block the core cannot read
 * while every gate in the repository stays green.
 *
 * Measured on this host, 2026-11-04: 23 391 blocks, exactly TWO of them
 * unreadable by the core — one with a type the enum does not have
 * (`autonom_publication`), one with no type at all. Everything else the
 * repository thought it knew about the vocabulary was right; the two
 * blocks were the whole hole.
 *
 * WHAT IT DOES
 *
 *   1. SCAN — every block in every chain the registry names (archives
 *      included), asking the core whether it can read it. The scan is
 *      read-only and it is the same question the audit asks.
 *   2. BACK UP — the operator's own backup mechanism, before a single
 *      byte is written. `memphis backup restore` is the way back.
 *   3. REWRITE — only the blocks the core refuses, into the shape it
 *      accepts: `system_event` with the original semantic name in
 *      `kind` (the convention from `block.rs:19`). The hash chain is
 *      re-linked from the first rewritten block onward.
 *   4. VERIFY — scan again. If the scan still finds something, the
 *      repair did not work and says so.
 *
 * THE BACKUP IS NOT OPTIONAL
 *
 * Rewriting a block changes the chain's history. That is a tier-2
 * operation: it needs the operator's consent (see
 * `src/infra/auth/operator-gate.ts`), and it needs a way back.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not add a variant to the Rust enum. The enum is the core's,
 * and the core is closed on purpose; the data is what adapts, not the
 * core. It does not rewrite blocks the core can read. It does not
 * touch the quarantine container or any sidecar directory: those are
 * not chains, and the registry says which directories are.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  blockNeedsVocabularyRepair,
  parseRawChainBlock,
  repairChainDirectoryVocabulary,
  type UnreadableBlockLocation,
} from './chain-canonical.js';
import { getBackupPath, getChainPath, getDataDir } from '../../config/paths.js';
import { logicalChainNameForDirectory } from '../../memory/chain-catalog.js';
import { BlockVocabularyOracle, type BlockVocabulary } from '../storage/block-vocabulary.js';
import { deriveChainRegistry } from '../storage/chain-adapter.js';
import { withChainWriteLock } from '../storage/chain-write-lock.js';

export interface VocabularyScan {
  /** False when the native core could not be reached — nothing was measured. */
  readonly oracleAvailable: boolean;
  /** How many blocks were read. */
  readonly blocksScanned: number;
  /** How many chain directories were read. */
  readonly chainsScanned: number;
  /** The blocks the core cannot read. */
  readonly unreadable: UnreadableBlockLocation[];
}

export interface VocabularyRepairOptions {
  readonly rawEnv?: NodeJS.ProcessEnv;
  /** Report what would change without writing anything. */
  readonly dryRun?: boolean;
  /** Skip the backup. Only for a dry run — a real repair always backs up. */
  readonly skipBackup?: boolean;
  /** The vocabulary to ask. Defaults to the native core. */
  readonly vocabulary?: BlockVocabulary;
  /** A scan already taken. Reused instead of scanning the chains twice. */
  readonly scan?: VocabularyScan;
}

export interface VocabularyRepairResult {
  readonly scan: VocabularyScan;
  readonly blocksRewritten: number;
  readonly directoriesRewritten: string[];
  readonly applied: string[];
  readonly skipped: string[];
  readonly warnings: string[];
  /** The archive the operator can restore from. */
  readonly backupFile?: string;
  /** The scan after the repair. */
  readonly verify?: VocabularyScan;
}

/**
 * Read every block of every chain the registry names and ask the core
 * whether it can read it.
 *
 * The registry is the code's own list (see `deriveChainRegistry`), so
 * the scan covers exactly the chains the verifier will open — including
 * the archives, which the verifier used to skip.
 */
export function scanChainVocabulary(
  rawEnv: NodeJS.ProcessEnv = process.env,
  vocabulary: BlockVocabulary = new BlockVocabularyOracle(rawEnv),
): VocabularyScan {
  if (!vocabulary.available()) {
    return { oracleAvailable: false, blocksScanned: 0, chainsScanned: 0, unreadable: [] };
  }

  const chainsDir = getChainPath(undefined, rawEnv);
  const unreadable: UnreadableBlockLocation[] = [];
  let blocksScanned = 0;
  let chainsScanned = 0;

  for (const directory of deriveChainRegistry(rawEnv)) {
    const chainDir = join(chainsDir, directory);
    if (!existsSync(chainDir)) continue;
    const files = readdirSync(chainDir)
      .filter((entry) => /^\d+\.json$/.test(entry))
      .sort((left, right) => left.localeCompare(right));
    if (files.length === 0) continue;
    chainsScanned += 1;

    for (const file of files) {
      const raw = parseRawChainBlock(readFileSync(join(chainDir, file), 'utf8'));
      if (!raw) {
        unreadable.push({
          chain: logicalChainNameForDirectory(directory),
          directory,
          file,
          error: 'the file is not a readable block',
        });
        continue;
      }
      blocksScanned += 1;

      const screening = blockNeedsVocabularyRepair(raw.data, vocabulary);
      if (!screening.needsRepair) continue;

      // The screening says the block cannot be read; the core says WHY.
      const complaint = vocabulary.complaint(raw) ?? screening.reason ?? 'unreadable';
      unreadable.push({
        chain: logicalChainNameForDirectory(directory),
        directory,
        file,
        type: typeof raw.data.type === 'string' ? raw.data.type : undefined,
        error: complaint,
      });
    }
  }

  return { oracleAvailable: true, blocksScanned, chainsScanned, unreadable };
}

/**
 * Repair the blocks the core cannot read.
 *
 * The order is not negotiable: scan, back up, rewrite, verify. A repair
 * that rewrites first and backs up afterwards is a repair that cannot be
 * undone.
 */
export async function repairChainVocabulary(
  options: VocabularyRepairOptions = {},
): Promise<VocabularyRepairResult> {
  const rawEnv = options.rawEnv ?? process.env;
  const applied: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  const vocabulary = options.vocabulary ?? new BlockVocabularyOracle(rawEnv);

  const scan = options.scan ?? scanChainVocabulary(rawEnv, vocabulary);
  if (!scan.oracleAvailable) {
    skipped.push(
      'the native core could not be loaded, so no block could be checked and nothing was rewritten',
    );
    return {
      scan,
      blocksRewritten: 0,
      directoriesRewritten: [],
      applied,
      skipped,
      warnings,
    };
  }

  if (scan.unreadable.length === 0) {
    applied.push(
      `chain vocabulary: every one of the ${scan.blocksScanned} live blocks is in the core's vocabulary`,
    );
    return { scan, blocksRewritten: 0, directoriesRewritten: [], applied, skipped, warnings };
  }

  const directories = [...new Set(scan.unreadable.map((entry) => entry.directory))];
  if (options.dryRun) {
    applied.push(
      `chain vocabulary: ${scan.unreadable.length} block(s) in ${directories.length} directory(ies) would be rewritten (dry run)`,
    );
    for (const entry of scan.unreadable) {
      applied.push(`  ${entry.directory}/${entry.file}: ${entry.error}`);
    }
    return { scan, blocksRewritten: 0, directoriesRewritten: [], applied, skipped, warnings };
  }

  let backupFile: string | undefined;
  if (!options.skipBackup) {
    // The operator's own backup mechanism: a tar.gz of the whole data
    // directory with a sha256 sidecar and a manifest entry, restorable
    // with `memphis backup restore`. Not a new format, not a new place.
    const { createBackup } = await import('../cli/commands/backup.js');
    const backup = await createBackup({
      memphisRoot: getDataDir(rawEnv),
      backupRoot: getBackupPath(rawEnv),
      tag: 'before-chain-vocabulary-repair',
      showProgress: false,
    });
    backupFile = backup.file;
    applied.push(`backed up the runtime to ${backup.file} before rewriting chain history`);
  }

  const chainsDir = getChainPath(undefined, rawEnv);
  const rewrittenDirectories: string[] = [];
  let blocksRewritten = 0;

  for (const directory of directories) {
    const chainDir = join(chainsDir, directory);
    const logical = logicalChainNameForDirectory(directory);
    // The same lock the writers take (shared with the native
    // `chain_write_lock.rs`). A rewrite that interleaved with an append
    // would produce a chain that is neither the old one nor the new one.
    const outcome = await withChainWriteLock(chainDir, async () =>
      repairChainDirectoryVocabulary(logical, chainDir, applied, warnings, { vocabulary }),
    );
    if (outcome.blocksRewritten > 0) {
      rewrittenDirectories.push(directory);
      blocksRewritten += outcome.blocksRewritten;
    }
  }

  const verify = scanChainVocabulary(rawEnv, vocabulary);
  if (verify.unreadable.length > 0) {
    warnings.push(
      `the vocabulary repair left ${verify.unreadable.length} unreadable block(s): ${verify.unreadable
        .map((entry) => `${entry.directory}/${entry.file}`)
        .join(', ')}`,
    );
  } else {
    applied.push(
      `chain vocabulary verified: all ${verify.blocksScanned} blocks are readable by the core`,
    );
  }

  return {
    scan,
    blocksRewritten,
    directoriesRewritten: rewrittenDirectories,
    applied,
    skipped,
    warnings,
    backupFile,
    verify,
  };
}
