import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type CiPreflightTriageContract = {
  gateIds: string[];
  ciWorkflowRequiredSnippets: string[];
  ciGateScriptPath: string;
  ciGateScriptRequiredSnippets: string[];
  runbookSectionHeading: string;
};

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const fixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'release-draft',
  'ci-preflight-triage-contract.json',
);

function extractDefaultGateIds(scriptSource: string): string[] {
  const defaultGatesMatch = scriptSource.match(
    /const\s+defaultGates\s*:\s*PreflightGate\[\]\s*=\s*\[([\s\S]*?)\n\];/,
  );
  if (!defaultGatesMatch) {
    throw new Error('unable to locate defaultGates in scripts/release-preflight.mts');
  }

  return [...defaultGatesMatch[1].matchAll(/id:\s*'([^']+)'/g)].map((match) => match[1]);
}

describe('release preflight CI triage mapping contract', () => {
  const contract = JSON.parse(readFileSync(fixturePath, 'utf8')) as CiPreflightTriageContract;

  it('keeps scripts/release-preflight.mts default gate IDs in fixture order', () => {
    const script = readFileSync(path.join(repoRoot, 'scripts', 'release-preflight.mts'), 'utf8');
    const gateIds = extractDefaultGateIds(script);

    expect(gateIds).toEqual(contract.gateIds);
  });

  it('keeps .github/workflows/ci.yml wired to the shared preflight gate script', () => {
    const ciWorkflow = readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

    for (const snippet of contract.ciWorkflowRequiredSnippets) {
      expect(ciWorkflow).toContain(snippet);
    }
  });

  it('keeps shared CI preflight gate script triage snippets required by the fixture', () => {
    const ciGateScript = readFileSync(path.join(repoRoot, contract.ciGateScriptPath), 'utf8');

    for (const snippet of contract.ciGateScriptRequiredSnippets) {
      expect(ciGateScript).toContain(snippet);
    }
  });

  it('keeps docs/runbooks/RELEASE.md triage section and per-gate headings', () => {
    const runbook = readFileSync(path.join(repoRoot, 'docs', 'runbooks', 'RELEASE.md'), 'utf8');

    expect(runbook).toContain(contract.runbookSectionHeading);
    for (const gateId of contract.gateIds) {
      expect(runbook).toContain(`### CI Preflight Gate ${gateId}`);
    }
  });
});
