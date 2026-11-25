/**
 * The skill contract gate — every skill says where it writes.
 *
 * WHY THIS EXISTS
 * ---------------
 * MEASURED 2026-09-22 on the operator's host: a skill wrote its audit
 * trail INSIDE the chain corpus (`chains/halt/*.json`), and a
 * non-conforming block there crashed Memphis at the next boot. The rule
 * that would have caught it existed only as a paragraph in a postmortem
 * (docs/postmortems/2026-09-22-chains-halt-invalid-block-shape.md, item
 * C1).
 *
 * The rule has one owner — `src/infra/audit/skill-sidecar-contract.ts` —
 * and two runners: this gate, over the skills in this repository, and the
 * contract corpus (`tests/fixtures/skill-contract-cases.json`), which pins
 * the rule itself.
 *
 * WHAT IS FLAGGED
 * ---------------
 *   - a skill with no "## Sidecar contract" section
 *   - a skill whose section does not declare its sidecar writes, or its
 *     audit target
 *   - a skill whose declaration is empty (write "none" if it writes
 *     nothing — that is an answer, not an omission)
 *   - a declared path under chains/ — the exact shape that crashed the
 *     runtime
 *
 * Run: `npm run -s ops:check-skill-contracts`
 * Hook: .githooks/pre-commit runs it on staged changes under skills/.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  findSkillContractFindings,
  type SkillContractFinding,
} from '../src/infra/audit/skill-sidecar-contract.js';

const REPO_ROOT = resolve('.');
const SKILLS_DIR = join(REPO_ROOT, 'skills');

interface SkillUnderTest {
  skillId: string;
  file: string;
  path: string;
}

function listSkills(): SkillUnderTest[] {
  if (!existsSync(SKILLS_DIR)) return [];
  const skills: SkillUnderTest[] = [];
  for (const entry of readdirSync(SKILLS_DIR, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const path = join(SKILLS_DIR, entry.name, 'SKILL.md');
    if (!existsSync(path)) continue;
    skills.push({ skillId: entry.name, file: `skills/${entry.name}/SKILL.md`, path });
  }
  return skills;
}

const skills = listSkills();
const findings: SkillContractFinding[] = [];

for (const skill of skills) {
  findings.push(
    ...findSkillContractFindings({
      skillId: skill.skillId,
      file: skill.file,
      src: readFileSync(skill.path, 'utf8'),
    }),
  );
}

if (findings.length > 0) {
  console.error('skill contract gate FAILED\n');
  for (const finding of findings) {
    console.error(`  ${finding.file} [${finding.rule}]: ${finding.problem}`);
  }
  console.error('');
  process.exit(1);
}

console.log(`skill contract gate OK — ${skills.length} skill(s) declare their sidecar writes`);
