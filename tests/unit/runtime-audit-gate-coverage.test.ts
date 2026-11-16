/**
 * The gate-coverage collector, asked directly.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The gate-coverage check answers one question per gate: "does this
 * gate measure something that can actually fail on this host?" Six gates
 * were measured in `docs/design/MEMPHIS-HOLES-AND-REFACTOR.md` §1 H7,
 * and four of them could not.
 *
 * The collector was private, so the only way to see what it said was to
 * read the whole audit report — which shows the verdict and the details
 * of EIGHT checks. When a mutation removed the secret-scan scope check
 * entirely, the report did not change in a way any test could see.
 *
 * So the collector is exported and asked here, one gate at a time.
 *
 * THE MEASURED TRAP THIS FILE EXISTS TO AVOID
 * --------------------------------------------
 * The secret scan's own header documents the history of the fix — and
 * the history contains the pattern `tests/*` that the script no longer
 * applies. A check that greps the whole file reports a hole that has
 * been closed, forever. The collector must read the EXECUTED lines.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { collectGateCoverage } from '../../src/infra/audit/runtime-audit.js';

describe('gate coverage · the secret scan is not exempt by path', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'memphis-gate-cov-'));
    await mkdir(path.join(root, 'scripts'), { recursive: true });
    await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const writeScript = async (text: string): Promise<void> => {
    await writeFile(path.join(root, 'scripts', 'default-secret-scan.sh'), text, 'utf8');
  };

  it('reports a hole when the scan skips tests/ by path', async () => {
    await writeScript(
      ['#!/usr/bin/env bash', 'case "$f" in', '  tests/*|*.test.ts) continue ;;', 'esac'].join(
        '\n',
      ),
    );
    const facts = await collectGateCoverage(root);
    expect(facts.misScoped.map((g) => g.gate)).toContain('default-secret-scan');
  });

  it('reports NO hole when the scan only MENTIONS the pattern in a comment', async () => {
    // This is the measured trap. The fixed script explains the history of
    // the fix, and the history contains `tests/*`. A gate that reads the
    // whole file reports a hole that was closed on 2026-11-16.
    await writeScript(
      [
        '#!/usr/bin/env bash',
        '# Until 2026-11-16 this gate skipped `tests/*` and every `*.test.*`.',
        'echo "scanning $(git ls-files)"',
      ].join('\n'),
    );
    const facts = await collectGateCoverage(root);
    expect(facts.misScoped.map((g) => g.gate)).not.toContain('default-secret-scan');
  });

  it('reports a hole when no workflow runs the cargo audit', async () => {
    await writeFile(
      path.join(root, '.github', 'workflows', 'ci.yml'),
      ['name: ci', 'jobs:', '  build:', '    steps:', '      - run: npm run build'].join('\n'),
      'utf8',
    );
    const facts = await collectGateCoverage(root);
    expect(facts.misScoped.map((g) => g.gate)).toContain('cargo audit');
  });

  it('reports NO hole when a workflow runs the cargo audit', async () => {
    await writeFile(
      path.join(root, '.github', 'workflows', 'rust-security.yml'),
      [
        'name: rust-security',
        'jobs:',
        '  cargo-audit:',
        '    steps:',
        '      - run: bash scripts/cargo-audit-check.sh',
      ].join('\n'),
      'utf8',
    );
    const facts = await collectGateCoverage(root);
    expect(facts.misScoped.map((g) => g.gate)).not.toContain('cargo audit');
  });

  it('says unmeasured when there is no repository', async () => {
    const facts = await collectGateCoverage(null);
    expect(facts.measured).toBe(false);
    expect(facts.misScoped).toEqual([]);
  });
});
