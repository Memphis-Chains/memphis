/**
 * The TypeScript arm of the classify-criteria contract, checked against
 * the fixture the native arm also reads.
 *
 * `tests/fixtures/classify-criteria-contract.json` holds the cases; the
 * native runner is
 * `crates/memphis-operator/tests/classify_criteria_contract.rs`.
 *
 * ## Why this test exists
 *
 * The registry declares `criteria` as a UNION — an object of labels, or
 * an array of 2-10 labels — and the gateway accepted both. The native
 * arm accepted only the object, so a model that had learned the array
 * form on Telegram got a refusal in the cockpit: the same tool, two
 * vocabularies.
 *
 * The fix is not "add the array form to the Rust side" — that is a
 * second copy of the rule, and the two copies would drift again. The
 * fix is ONE normalisation and ONE fixture that both arms are checked
 * against, which is the pattern the journal-target allowlist already
 * uses.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  normalizeClassifyOptions,
  type ClassifyQuestionType,
} from '../../src/mcp/tools/classify.js';

interface ContractCase {
  name: string;
  criteria: Record<string, string> | string[];
  type: ClassifyQuestionType;
  expected?: Array<[string, string]>;
  error?: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(here, '..', 'fixtures', 'classify-criteria-contract.json');

const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { cases: ContractCase[] };

describe('the classify-criteria contract — the two arms agree', () => {
  it('holds at least one case', () => {
    expect(fixture.cases.length).toBeGreaterThan(0);
  });

  it('normalises every case the way the contract says', () => {
    for (const testCase of fixture.cases) {
      const result = normalizeClassifyOptions(testCase.criteria, testCase.type);
      if (testCase.error !== undefined) {
        expect(result.error, testCase.name).toBe(testCase.error);
        expect(result.options, testCase.name).toBeUndefined();
        continue;
      }
      expect(result.error, testCase.name).toBeUndefined();
      expect(
        result.options?.map((option) => [option.key, option.description]),
        testCase.name,
      ).toEqual(testCase.expected);
    }
  });

  it('accepts the array form the registry declares', () => {
    // The union the registry declares: an object of labels, or an array
    // of 2-10 labels. The array form is the one the native arm refused.
    const asArray = fixture.cases.filter(
      (testCase) => Array.isArray(testCase.criteria) && testCase.error === undefined,
    );
    expect(asArray.length).toBeGreaterThan(0);
    for (const testCase of asArray) {
      const result = normalizeClassifyOptions(testCase.criteria, testCase.type);
      expect(result.error, testCase.name).toBeUndefined();
    }
  });
});
