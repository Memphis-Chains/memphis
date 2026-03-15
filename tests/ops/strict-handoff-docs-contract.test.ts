import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

const docsToCheck = [
  'README.md',
  path.join('docs', 'runbooks', 'INCIDENT_MANIFEST_VERIFICATION.md'),
] as const;

const requiredStrictFixtureReferences = [
  'tests/fixtures/strict-handoff/output-contract.json',
  'tests/fixtures/strict-handoff/summary.schema.json',
  'tests/fixtures/strict-handoff/completion-hints.schema.json',
  'tests/fixtures/strict-handoff/validator-output-contract.json',
  'tests/fixtures/strict-handoff/summary-example-preflight.json',
  'tests/fixtures/strict-handoff/completion-hints-example.json',
  'tests/fixtures/strict-handoff/failure-preflight.json',
  'tests/fixtures/strict-handoff/failure-export.json',
  'tests/fixtures/strict-handoff/failure-verify.json',
] as const;

function extractStrictFixtureReferences(markdown: string): Set<string> {
  return new Set(markdown.match(/tests\/fixtures\/strict-handoff\/[a-z0-9.-]+\.json/g) ?? []);
}

describe('strict-handoff docs fixture references', () => {
  for (const docRelativePath of docsToCheck) {
    it(`${docRelativePath} references existing strict-handoff fixture files`, () => {
      const docPath = path.join(repoRoot, docRelativePath);
      const markdown = readFileSync(docPath, 'utf8');
      const references = extractStrictFixtureReferences(markdown);
      expect(references.size).toBeGreaterThanOrEqual(requiredStrictFixtureReferences.length);

      for (const expectedRef of requiredStrictFixtureReferences) {
        expect(markdown.includes(expectedRef)).toBe(true);
        expect(references.has(expectedRef)).toBe(true);
      }

      for (const ref of references) {
        expect(existsSync(path.join(repoRoot, ref))).toBe(true);
      }
    });
  }
});
