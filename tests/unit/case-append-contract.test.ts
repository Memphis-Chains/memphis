/**
 * The TypeScript arm of the case-append contract, checked against the
 * fixture the native arm also reads.
 *
 * `tests/fixtures/case-append-contract.json` holds the cases; the native
 * runner is `crates/memphis-operator/tests/case_append_contract.rs`.
 *
 * ## Why this test exists
 *
 * The registry accepts the flat form as well as `{entry: {...}}`, and the
 * gateway normalised the two into one shape. The native arm required the
 * wrapped form, so a model that had learned the flat form on Telegram
 * got a refusal in the cockpit — and the flat form is the one the
 * registry's own help text shows first.
 *
 * ONE normalisation, checked from both sides against ONE table of cases:
 * a rule copied into a second language is a rule that drifts.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { normalizeCaseAppendInput } from '../../src/mcp/tools/case-entry.js';

interface ContractCase {
  name: string;
  arguments: Record<string, unknown>;
  expected: Record<string, unknown>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(here, '..', 'fixtures', 'case-append-contract.json');

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { cases: ContractCase[] };

describe('the case-append contract — the two arms agree', () => {
  it('holds at least one case', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it('normalises every case the way the contract says', () => {
    for (const testCase of fixture.cases) {
      const normalized = normalizeCaseAppendInput(
        testCase.arguments as never,
      ) as unknown as Record<string, unknown>;
      for (const [field, value] of Object.entries(testCase.expected)) {
        expect(normalized[field], `${testCase.name}: ${field}`).toEqual(value);
      }
    }
  });

  it('accepts the flat form the registry declares', () => {
    const flat = fixture.cases.filter((testCase) => testCase.arguments.entry === undefined);
    expect(flat.length).toBeGreaterThan(0);
    for (const testCase of flat) {
      const normalized = normalizeCaseAppendInput(
        testCase.arguments as never,
      ) as unknown as Record<string, unknown>;
      expect(normalized.case_type, testCase.name).toBe(testCase.expected.case_type);
    }
  });

  it('prefers the wrapped form when both are present', () => {
    const both = fixture.cases.filter(
      (testCase) =>
        testCase.arguments.entry !== undefined && testCase.arguments.case_type !== undefined,
    );
    for (const testCase of both) {
      const normalized = normalizeCaseAppendInput(
        testCase.arguments as never,
      ) as unknown as Record<string, unknown>;
      expect(normalized.case_type, testCase.name).toBe(testCase.expected.case_type);
    }
  });
});
