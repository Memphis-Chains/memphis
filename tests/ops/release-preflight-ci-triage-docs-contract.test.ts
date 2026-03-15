import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type CiPreflightTriageDocsContract = {
  gateIds: string[];
  readmePath: string;
  runbookPath: string;
  requiredReadmeSnippets: string[];
  requiredRunbookSnippets: string[];
};

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const fixturePath = path.join(
  repoRoot,
  'tests',
  'fixtures',
  'release-draft',
  'ci-preflight-triage-docs-contract.json',
);

function assertGateAnchorOrder(runbook: string, gateIds: string[]): void {
  const gatePositions = gateIds.map((gateId) => {
    const anchor = `<a id="ci-preflight-gate-${gateId}"></a>`;
    const index = runbook.indexOf(anchor);
    expect(index, `missing runbook anchor ${anchor}`).toBeGreaterThanOrEqual(0);
    return { gateId, index };
  });

  for (let index = 1; index < gatePositions.length; index += 1) {
    const previous = gatePositions[index - 1];
    const current = gatePositions[index];
    expect(
      current.index,
      `runbook gate anchor order drift: ${previous.gateId} should come before ${current.gateId}`,
    ).toBeGreaterThan(previous.index);
  }
}

describe('release preflight triage docs contract', () => {
  const contract = JSON.parse(readFileSync(fixturePath, 'utf8')) as CiPreflightTriageDocsContract;
  const readme = readFileSync(path.join(repoRoot, contract.readmePath), 'utf8');
  const runbook = readFileSync(path.join(repoRoot, contract.runbookPath), 'utf8');

  it('keeps README release section reference to gate-id triage anchors', () => {
    for (const snippet of contract.requiredReadmeSnippets) {
      expect(readme).toContain(snippet);
    }
  });

  it('keeps runbook triage map section and fallback anchor', () => {
    for (const snippet of contract.requiredRunbookSnippets) {
      expect(runbook).toContain(snippet);
    }
  });

  it('keeps one explicit runbook anchor and heading per preflight gate id in fixture order', () => {
    assertGateAnchorOrder(runbook, contract.gateIds);

    for (const gateId of contract.gateIds) {
      expect(runbook).toContain(`### CI Preflight Gate ${gateId}`);
      expect(runbook).toContain(`<a id="ci-preflight-gate-${gateId}"></a>`);
    }
  });
});
