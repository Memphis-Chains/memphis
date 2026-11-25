/**
 * The skill sidecar contract — every skill states where it writes.
 *
 * WHY THIS EXISTS
 * ---------------
 * Postmortem item C1 (docs/postmortems/2026-09-22-chains-halt-invalid-block-shape.md):
 *
 *     "C1. New-skill contract. Any new skill under `skills/<name>/` must
 *      include `compat.test.sh` asserting that any persistent write passes
 *      `memphis chain verify --strict` if written under `chains/`, or stays
 *      outside `chains/` if sidecar."
 *
 * MEASURED 2026-09-22 on the operator's host: a skill wrote its audit
 * trail INSIDE the chain corpus — `chains/halt/*.json` — and a
 * non-conforming block there crashed Memphis at the next boot. The rule
 * that would have caught it existed only as a paragraph in a postmortem.
 *
 * The original wording asked for a `compat.test.sh` per skill. That is a
 * copy of the same rule in every skill directory, and a copy per
 * directory is how rules drift: seven copies, seven chances to differ.
 * So the rule has ONE owner — this module — and every skill DECLARES
 * where it writes, in a section the gate reads:
 *
 *     ## Sidecar contract
 *
 *     - **Sidecar writes:** `~/.memphis/audit/halt/events.jsonl`
 *     - **Audit target:** `~/.memphis/audit/halt/events.jsonl`
 *
 * A skill that writes nothing persistent says `none` — that is an
 * answer, not an omission. The gate checks that the answer exists, and
 * that no declared path is under `chains/`.
 *
 * TWO RUNNERS
 * -----------
 * The gate (`scripts/check-skill-contracts.mts`) reads every skill in
 * the repository; the contract corpus
 * (`tests/fixtures/skill-contract-cases.json`) pins the rule itself.
 */

/** A finding about one skill. */
export interface SkillContractFinding {
  /** The rule that fired. */
  rule:
    | 'missing-section'
    | 'missing-declaration'
    | 'empty-declaration'
    | 'writes-under-chains'
    | 'audit-under-chains';
  /** The skill's id. */
  skillId: string;
  /** The file the finding is about. */
  file: string;
  /** What is wrong, in the operator's words. */
  problem: string;
}

/** The section heading the contract lives under. */
export const SKILL_CONTRACT_HEADING = '## Sidecar contract';

/** The two lines a skill must carry under the heading. */
export const SKILL_CONTRACT_LINES = {
  sidecarWrites: 'Sidecar writes:',
  auditTarget: 'Audit target:',
} as const;

/** What a skill declares about its own writes. */
export interface SkillSidecarDeclaration {
  /** The paths the skill writes persistently. Empty when it declares `none`. */
  sidecarWrites: string[];
  /** The audit trail the skill writes. Empty when it declares `none`. */
  auditTarget: string[];
  /** The raw value of each line, for the operator's eyes. */
  rawSidecarWrites?: string;
  rawAuditTarget?: string;
}

/**
 * Is this path under the chain corpus?
 *
 * `chains/halt/` and `chains/anything/` are both inside the corpus — the
 * rule is about the DIRECTORY, not about the shape of the name. A path
 * that merely mentions "chains" in a longer path (`/srv/chains-backup/x`)
 * is outside it.
 */
export function isUnderChains(path: string): boolean {
  const normalized = path.trim().replace(/^~(?=\/)/, 'HOME');
  const segments = normalized.split('/').filter(Boolean);
  return segments[0] === 'chains';
}

/**
 * Read the declaration out of a SKILL.md.
 *
 * The section is read until the next heading. The two lines are
 * recognised by their labels; the paths are the backticked tokens.
 */
export function parseSkillSidecarDeclaration(src: string): SkillSidecarDeclaration {
  const lines = src.split('\n');
  const start = lines.findIndex((line) => line.trim() === SKILL_CONTRACT_HEADING);
  if (start === -1) {
    return { sidecarWrites: [], auditTarget: [] };
  }

  const section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) break;
    section.push(trimmed);
  }

  const declaration: SkillSidecarDeclaration = { sidecarWrites: [], auditTarget: [] };
  for (const line of section) {
    const sidecarMatch = line.match(new RegExp(`${SKILL_CONTRACT_LINES.sidecarWrites}\\s*(.*)`));
    if (sidecarMatch) {
      // The line reads `- **Sidecar writes:** none`, so the captured tail
      // starts with the closing emphasis marker. Strip it, or "none"
      // becomes the path "** none".
      declaration.rawSidecarWrites = cleanDeclarationValue(sidecarMatch[1] ?? '');
      declaration.sidecarWrites = pathsFromValue(declaration.rawSidecarWrites);
      continue;
    }
    const auditMatch = line.match(new RegExp(`${SKILL_CONTRACT_LINES.auditTarget}\\s*(.*)`));
    if (auditMatch) {
      declaration.rawAuditTarget = cleanDeclarationValue(auditMatch[1] ?? '');
      declaration.auditTarget = pathsFromValue(declaration.rawAuditTarget);
    }
  }

  return declaration;
}

/** The value of a declaration line, without markdown emphasis. */
function cleanDeclarationValue(value: string): string {
  return value.replace(/^[*_\s]+/, '').trim();
}

/**
 * The paths in a declared value.
 *
 * Backticked tokens are the paths. A value that starts with "none"
 * (with or without an explanation after it) means "this skill declares no
 * such write" — an answer, not an omission.
 */
function pathsFromValue(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  const backticked = [...trimmed.matchAll(/`([^`]+)`/g)].map((match) => match[1]!.trim());
  if (backticked.length > 0) return backticked.filter(Boolean);
  const bare = trimmed.replace(/^[-\s]+/, '').trim();
  if (bare.length === 0) return [];
  if (/^(none|n\/a|brak|no)\b/i.test(bare)) return [];
  return [bare];
}

/**
 * The rules, applied to one skill.
 *
 * Returns an empty array when the skill satisfies the contract.
 */
export function findSkillContractFindings(input: {
  skillId: string;
  file: string;
  src: string;
}): SkillContractFinding[] {
  const findings: SkillContractFinding[] = [];
  const { skillId, file, src } = input;

  const hasSection = src.split('\n').some((line) => line.trim() === SKILL_CONTRACT_HEADING);
  if (!hasSection) {
    findings.push({
      rule: 'missing-section',
      skillId,
      file,
      problem:
        `no "${SKILL_CONTRACT_HEADING}" section — a skill that does not say where it ` +
        'writes cannot be checked against the rule that keeps writes out of chains/',
    });
    return findings;
  }

  const declaration = parseSkillSidecarDeclaration(src);

  if (declaration.rawSidecarWrites === undefined) {
    findings.push({
      rule: 'missing-declaration',
      skillId,
      file,
      problem: `the contract section does not say "${SKILL_CONTRACT_LINES.sidecarWrites}"`,
    });
  } else if (declaration.rawSidecarWrites.length === 0) {
    findings.push({
      rule: 'empty-declaration',
      skillId,
      file,
      problem: `"${SKILL_CONTRACT_LINES.sidecarWrites}" is empty — write "none" if the skill writes nothing`,
    });
  }

  if (declaration.rawAuditTarget === undefined) {
    findings.push({
      rule: 'missing-declaration',
      skillId,
      file,
      problem: `the contract section does not say "${SKILL_CONTRACT_LINES.auditTarget}"`,
    });
  } else if (declaration.rawAuditTarget.length === 0) {
    findings.push({
      rule: 'empty-declaration',
      skillId,
      file,
      problem: `"${SKILL_CONTRACT_LINES.auditTarget}" is empty — write "none" if the skill writes no audit trail`,
    });
  }

  for (const path of declaration.sidecarWrites) {
    if (isUnderChains(path)) {
      findings.push({
        rule: 'writes-under-chains',
        skillId,
        file,
        problem:
          `the sidecar write "${path}" is under chains/ — a non-conforming block in the ` +
          'chain corpus crashes Memphis at the next boot; move the write outside the corpus',
      });
    }
  }

  for (const path of declaration.auditTarget) {
    if (isUnderChains(path)) {
      findings.push({
        rule: 'audit-under-chains',
        skillId,
        file,
        problem:
          `the audit target "${path}" is under chains/ — the audit trail of a skill ` +
          'belongs outside the chain corpus',
      });
    }
  }

  return findings;
}
