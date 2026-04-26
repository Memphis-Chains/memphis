/**
 * Regression: archived directories must NOT come back into the active repo.
 *
 * `openclaw-plugin/` was archived from inception (its README explicitly said
 * so) and was kept around with two enforcing contract tests
 * (openclaw-plugin-archive-contract.test.ts + openclaw-docs-truth-contract
 * .test.ts) that asserted it stayed marked private. S5 (2026-04-26) deleted
 * the plugin and those contract tests; this test codifies the deletion so
 * the directory cannot silently reappear.
 *
 * Add new entries to `forbidden` if other archived dryf reappear; do NOT
 * remove entries — that's the point.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

const forbidden = [
  'openclaw-plugin',
  'tests/ops/openclaw-plugin-archive-contract.test.ts',
  'tests/ops/openclaw-docs-truth-contract.test.ts',
  // legacy/tui-ts/ — TS TUI archive removed S5 (2026-04-26); active TUI
  // is the Rust crate under crates/memphis-tui/. The whole `legacy/`
  // tree was deleted in the same sweep.
  'legacy',
  'legacy/tui-ts',
];

describe('no archived stubs in active repo', () => {
  for (const rel of forbidden) {
    it(`${rel} must not exist`, () => {
      expect(existsSync(path.join(repoRoot, rel))).toBe(false);
    });
  }
});
