/**
 * Chain migration registry.
 *
 * Each migration bumps the schema version by exactly one step. The
 * runner composes them in order to upgrade from any historical
 * version to the current head.
 *
 * Adding a new migration:
 *   1. Create a file in this directory named `migration-v<N>-to-v<N+1>.ts`
 *   2. Export a `ChainMigration` with description + transformBlock
 *   3. Import it here and append to MIGRATIONS
 *   4. Bump `CURRENT_SCHEMA_VERSION`
 *   5. Add a test in tests/unit/chain-migrations.test.ts covering a
 *      sample old-shape block → new-shape roundtrip
 */

import type { ChainMigration } from './types.js';

// Current schema version — chain blocks written AFTER a successful
// migration carry this value in `schemaVersion`. Blocks without a
// schemaVersion field are assumed to be v1 (legacy).
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * All known migrations in order (v1 → v2 → v3 → ...).
 * Empty until the first real schema change ships — the scaffold is
 * here so that change is a one-file PR + test, not a framework build.
 */
export const MIGRATIONS: ChainMigration[] = [];

export function getCurrentVersion(): number {
  return CURRENT_SCHEMA_VERSION;
}

export function getMigrationsFrom(startVersion: number): ChainMigration[] {
  return MIGRATIONS.filter((m) => m.from >= startVersion && m.to <= CURRENT_SCHEMA_VERSION).sort(
    (a, b) => a.from - b.from,
  );
}

/**
 * Sample migration template (commented out). Un-comment + import + push
 * to MIGRATIONS when a real schema change ships. Kept here so the
 * first-ever migration author has a working example to copy.
 *
 * export const migrationV1ToV2: ChainMigration = {
 *   from: 1,
 *   to: 2,
 *   description: 'add explicit schemaVersion; normalize timestamps to UTC',
 *   transformBlock: (block) => ({
 *     ...block,
 *     schemaVersion: 2,
 *     timestamp: new Date(block.timestamp).toISOString(),
 *   }),
 * };
 */
