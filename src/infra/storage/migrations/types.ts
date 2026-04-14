/**
 * Chain schema migration framework (Phase 3.2 production sprint).
 *
 * The chain block format currently ships at `schemaVersion: 1`. If we
 * ever need to evolve it (add/remove fields, change canonical-hash
 * inputs, normalize timestamps), existing operators are stranded
 * unless we ship a tested migration path. Ship the scaffold BEFORE
 * we need it — the first forced migration under pressure is the
 * worst place to design the framework.
 *
 * Per-migration contract:
 *   - `from` / `to` version numbers (strictly monotonic, positive int).
 *   - `transformBlock(raw)` — receives the parsed block with the OLD
 *     shape and returns the NEW shape, or throws if the block can't
 *     migrate (migration aborts; nothing persisted).
 *   - `description` — one-line human-readable summary for audit logs.
 *
 * The runner walks every block file in each chain, reads the file,
 * applies the transform, re-computes the hash under the NEW canonical
 * form, atomically writes (tmp + rename) the result, and verifies the
 * whole chain in dry-run mode first. Failure at any step aborts and
 * leaves the on-disk state untouched (we write to a tmp dir first;
 * only swap directories when every file is converted cleanly).
 */

export interface MigratableBlock {
  index: number;
  timestamp: string;
  chain: string;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
  schemaVersion?: number;
  signer?: string;
  signature?: string;
  [extra: string]: unknown;
}

export interface ChainMigration {
  from: number;
  to: number;
  description: string;
  transformBlock: (block: MigratableBlock) => MigratableBlock;
}

export interface MigrationRunOptions {
  rawEnv?: NodeJS.ProcessEnv;
  /** Only simulate — don't touch real data. */
  dryRun?: boolean;
  /** Test seam: substitute the migration set. */
  migrationsOverride?: ChainMigration[];
  /** Test seam: override chain-base path. */
  chainBaseDir?: string;
}

export interface PerChainMigrationReport {
  chain: string;
  fromVersion: number;
  toVersion: number;
  blocksConsidered: number;
  blocksMigrated: number;
  skipped?: 'already-current' | 'empty-chain';
  error?: string;
}

export interface MigrationRunResult {
  ok: boolean;
  dryRun: boolean;
  targetVersion: number;
  migrations: Array<{ from: number; to: number; description: string }>;
  perChain: PerChainMigrationReport[];
  error?: string;
}
