/**
 * The TypeScript arm of the self-modify contract, checked against the
 * fixture the native arm also reads.
 *
 * `tests/fixtures/self-modify-contract.json` holds the cases; the native
 * runner is `crates/memphis-operator/tests/self_modify_contract.rs`.
 *
 * ## Why this test exists
 *
 * `memphis_self_modify` had three implementations that did not agree:
 *
 *   - the MCP server read the registry's five fields;
 *   - the gateway's own executor read the same five fields but normalised
 *     them first — it filtered junk out of `files` instead of refusing it;
 *   - the native arm accepted `{path, content, mode}` and wrote ONE file,
 *     where the registry means "apply changes to many files".
 *
 * One name, two operations — and a model that had learned one vocabulary
 * met the other. The fix is ONE rule in ONE place per language, checked
 * from both sides against ONE table of cases. The digests in the fixture
 * are the proof: the same call must produce the same bytes on both arms,
 * so the operator sees one digest wherever the request was made.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  canonicalEvolveRequest,
  evolveRequestDigest,
} from '../../src/infra/runtime/evolve-request.js';

interface ContractCase {
  name: string;
  arguments: Record<string, unknown>;
  expand?: { file: string; times: number; unit: string };
  error?: string;
  expected?: { payload: string; digest: string };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(here, '..', 'fixtures', 'self-modify-contract.json');

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { cases: ContractCase[] };

/** The arguments of a case, with the grown content the fixture asks for. */
function argumentsOf(testCase: ContractCase): Record<string, unknown> {
  const args = { ...testCase.arguments };
  if (!testCase.expand) return args;
  const changes = { ...(args.changes as Record<string, string>) };
  changes[testCase.expand.file] = testCase.expand.unit.repeat(testCase.expand.times);
  args.changes = changes;
  return args;
}

describe('the self-modify contract — the two arms agree', () => {
  it('holds at least one case', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it('builds the canonical payload the contract says', () => {
    for (const testCase of fixture.cases) {
      if (!testCase.expected) continue;
      const canonical = canonicalEvolveRequest(argumentsOf(testCase));
      expect(canonical.payload, `${testCase.name}: the payload`).toBe(testCase.expected.payload);
      expect(
        evolveRequestDigest(canonical.payload),
        `${testCase.name}: the digest`,
      ).toBe(testCase.expected.digest);
    }
  });

  it('refuses what the contract refuses, in the same words', () => {
    for (const testCase of fixture.cases) {
      if (!testCase.error) continue;
      let refusal = '';
      try {
        canonicalEvolveRequest(argumentsOf(testCase));
      } catch (error) {
        refusal = error instanceof Error ? error.message : String(error);
      }
      expect(refusal, `${testCase.name}: the refusal`).toBe(testCase.error);
    }
  });

  it('never carries a passphrase or a transport key into the request', () => {
    for (const testCase of fixture.cases) {
      if (!testCase.expected) continue;
      const canonical = canonicalEvolveRequest(argumentsOf(testCase));
      expect(canonical.payload, testCase.name).not.toContain('passphrase');
      expect(canonical.payload, testCase.name).not.toContain('approval_request_id');
    }
  });
});
