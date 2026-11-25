/**
 * The skill sidecar contract — the corpus and the skills in this
 * repository.
 *
 * Postmortem item C1 (docs/postmortems/2026-09-22-chains-halt-invalid-block-shape.md):
 * a skill wrote its audit trail inside the chain corpus and a
 * non-conforming block there crashed Memphis at the next boot. The rule
 * that would have caught it existed only as a paragraph.
 *
 * The rule has one owner (`src/infra/audit/skill-sidecar-contract.ts`) and
 * two runners: the gate (`scripts/check-skill-contracts.mts`) and this
 * file. The cases live in `tests/fixtures/skill-contract-cases.json`.
 *
 * The second half of this file reads the skills in THIS repository: the
 * corpus pins the rule, and this pins the answer — a skill that drifts
 * out of the contract fails here, not in a postmortem six months later.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  findSkillContractFindings,
  isUnderChains,
  parseSkillSidecarDeclaration,
} from '../../src/infra/audit/skill-sidecar-contract.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const CASES_PATH = join(REPO_ROOT, 'tests/fixtures/skill-contract-cases.json');

interface ContractCase {
  name: string;
  skillId: string;
  skill: string;
  expectedRules: string[];
}

interface Contract {
  description: string;
  cases: ContractCase[];
}

const contract = JSON.parse(readFileSync(CASES_PATH, 'utf8')) as Contract;

describe('skill sidecar contract — the corpus', () => {
  it('the corpus is not empty', () => {
    expect(contract.cases.length).toBeGreaterThan(0);
  });

  for (const testCase of contract.cases) {
    it(testCase.name, () => {
      const findings = findSkillContractFindings({
        skillId: testCase.skillId,
        file: `skills/${testCase.skillId}/SKILL.md`,
        src: testCase.skill,
      });
      expect(findings.map((finding) => finding.rule)).toEqual(testCase.expectedRules);
    });
  }
});

describe('skill sidecar contract — the rules themselves', () => {
  it('knows what is under the chain corpus', () => {
    expect(isUnderChains('chains/halt/events.jsonl')).toBe(true);
    expect(isUnderChains('chains')).toBe(true);
    expect(isUnderChains('/home/memphis/.memphis/chains/halt')).toBe(false);
    expect(isUnderChains('/srv/chains-backup/events.jsonl')).toBe(false);
    expect(isUnderChains('~/.memphis/audit/halt/events.jsonl')).toBe(false);
  });

  it('reads the paths out of a declaration', () => {
    const declaration = parseSkillSidecarDeclaration(
      [
        '## Sidecar contract',
        '',
        '- **Sidecar writes:** `~/.memphis/audit/halt/events.jsonl`, `~/.memphis/halt/`',
        '- **Audit target:** `~/.memphis/audit/halt/events.jsonl`',
      ].join('\n'),
    );
    expect(declaration.sidecarWrites).toEqual([
      '~/.memphis/audit/halt/events.jsonl',
      '~/.memphis/halt/',
    ]);
    expect(declaration.auditTarget).toEqual(['~/.memphis/audit/halt/events.jsonl']);
  });

  it('reads a "none" declaration as no paths at all', () => {
    const declaration = parseSkillSidecarDeclaration(
      ['## Sidecar contract', '', '- **Sidecar writes:** none', '- **Audit target:** none'].join(
        '\n',
      ),
    );
    expect(declaration.sidecarWrites).toEqual([]);
    expect(declaration.auditTarget).toEqual([]);
  });
});

describe('skill sidecar contract — the skills in this repository', () => {
  it('every skill declares where it writes, and nothing writes under chains/', () => {
    const skillsDir = join(REPO_ROOT, 'skills');
    const skillIds = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    expect(skillIds.length).toBeGreaterThan(0);

    const findings = skillIds.flatMap((skillId) => {
      const file = join(skillsDir, skillId, 'SKILL.md');
      if (!existsSync(file)) return [];
      return findSkillContractFindings({
        skillId,
        file: `skills/${skillId}/SKILL.md`,
        src: readFileSync(file, 'utf8'),
      });
    });

    expect(
      findings.map((finding) => `${finding.file} [${finding.rule}]: ${finding.problem}`),
    ).toEqual([]);
  });
});
