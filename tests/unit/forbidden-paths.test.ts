/**
 * The forbidden-path rule, pinned by its corpus.
 *
 * The corpus (`tests/fixtures/forbidden-path-cases.json`) is the rule's
 * executable form. This test walks it and asks the owner module
 * (`src/infra/audit/forbidden-paths.ts`) for a verdict on every case, so
 * a change to the rule that breaks a case fails here rather than in
 * production.
 *
 * The cases also cover the two shapes a naive rule gets wrong: a template
 * that IS allowed (`.env.example`), and a document whose NAME looks like a
 * forbidden directory (`docs/design/dist.md`).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ALLOWED_ENV_TEMPLATE,
  findForbiddenPathFindings,
  isSecretEnvFile,
  isUnderBuildOutput,
} from '../../src/infra/audit/forbidden-paths.js';

interface CorpusCase {
  path: string;
  forbidden: boolean;
  rule: string | null;
  why: string;
}

const corpus = JSON.parse(
  readFileSync(resolve('tests/fixtures/forbidden-path-cases.json'), 'utf8'),
) as { cases: CorpusCase[] };

describe('forbidden-path rule', () => {
  it('has a corpus to pin', () => {
    expect(corpus.cases.length).toBeGreaterThan(0);
  });

  it.each(corpus.cases.map((c) => [c.path, c] as const))(
    'applies the rule to %s',
    (_path, corpusCase) => {
      const findings = findForbiddenPathFindings([corpusCase.path]);
      if (!corpusCase.forbidden) {
        expect(findings).toEqual([]);
        return;
      }
      expect(findings).toHaveLength(1);
      expect(findings[0]!.rule).toBe(corpusCase.rule);
      expect(findings[0]!.path).toBe(corpusCase.path);
      expect(findings[0]!.problem.length).toBeGreaterThan(0);
    },
  );

  it('names the template that is allowed', () => {
    expect(ALLOWED_ENV_TEMPLATE).toBe('.env.example');
    expect(isSecretEnvFile('.env.example')).toBe(false);
    expect(isSecretEnvFile('.env')).toBe(true);
  });

  it('judges directories, not names', () => {
    expect(isUnderBuildOutput('dist/infra/cli/index.js')).toBe(true);
    expect(isUnderBuildOutput('node_modules/tsx/package.json')).toBe(true);
    expect(isUnderBuildOutput('docs/design/dist.md')).toBe(false);
    expect(isUnderBuildOutput('src/distribution.ts')).toBe(false);
  });

  it('reports every offending path, not only the first', () => {
    const findings = findForbiddenPathFindings([
      '.env',
      'src/index.ts',
      '.github-pat',
      'dist/x.js',
    ]);
    expect(findings.map((f) => f.rule)).toEqual(['secret-env', 'github-pat', 'build-output']);
  });

  it('never opens the file it judges', () => {
    // The rule is about paths. A path that does not exist must be judged
    // exactly like a path that does: the gate reads names, never content.
    const findings = findForbiddenPathFindings(['/nonexistent/.env']);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.rule).toBe('secret-env');
  });

  it('ignores empty input', () => {
    expect(findForbiddenPathFindings([])).toEqual([]);
    expect(findForbiddenPathFindings(['', '   '])).toEqual([]);
  });
});
