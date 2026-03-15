import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import YAML from 'yaml';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');

const workflowContracts = [
  {
    workflowRelativePath: path.join('.github', 'workflows', 'ci.yml'),
    requiredSnippets: ['./scripts/ci-release-preflight-gate.sh'],
    forbiddenSnippets: [
      'npm run -s lint',
      'npm run -s typecheck',
      'npm run -s ops:validate-strict-handoff-fixtures',
      './scripts/strict-handoff-validator-json-gate.sh',
      'npm run -s test:ops-artifacts',
      'npm run -s test:ts',
      'npm run -s test:chaos',
      'npm run -s test:rust',
    ],
  },
  {
    workflowRelativePath: path.join('.github', 'workflows', 'release-draft-dispatch.yml'),
    requiredSnippets: ['./scripts/ci-release-preflight-gate.sh'],
    forbiddenSnippets: [],
  },
] as const;

const releaseDraftRequiredSnippets = [
  'MEMPHIS_STRICT_HANDOFF_GATE_OUTPUT: "1"',
  'MEMPHIS_RELEASE_PREFLIGHT_GATE_OUTPUT: "1"',
  'validator_check_order_status',
  'validator_check_ids',
] as const;

const gateScriptRequiredSnippets = [
  `OUT="$(npm run -s ops:validate-strict-handoff-fixtures -- --json)"`,
  `jq -e '.ok == true' <<<"$OUT" >/dev/null`,
  `EXPECTED_IDS="$(jq -c '.checkIds' tests/fixtures/strict-handoff/validator-output-contract.json)"`,
  `ACTUAL_IDS="$(jq -c '.checks | map(.id)' <<<"$OUT")"`,
  'strict-handoff validator check-id ordering mismatch',
  'echo "check_order_status=matched" >>"$GITHUB_OUTPUT"',
  'echo "check_ids=$ACTUAL_IDS" >>"$GITHUB_OUTPUT"',
] as const;

describe('strict-handoff workflow contracts', () => {
  for (const { workflowRelativePath, requiredSnippets, forbiddenSnippets } of workflowContracts) {
    it(`${workflowRelativePath} stays valid YAML for GitHub Actions parsing`, () => {
      const workflow = readFileSync(path.join(repoRoot, workflowRelativePath), 'utf8');

      expect(() => YAML.parse(workflow)).not.toThrow();
    });

    it(`${workflowRelativePath} keeps strict-handoff gate contract wiring`, () => {
      const workflow = readFileSync(path.join(repoRoot, workflowRelativePath), 'utf8');

      for (const snippet of requiredSnippets) {
        expect(workflow).toContain(snippet);
      }
      for (const snippet of forbiddenSnippets) {
        expect(workflow).not.toContain(snippet);
      }
    });
  }

  it('release-draft emits machine-readable check-order outputs and summary fields', () => {
    const workflow = readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'release-draft-dispatch.yml'),
      'utf8',
    );

    for (const snippet of releaseDraftRequiredSnippets) {
      expect(workflow).toContain(snippet);
    }
    expect(workflow).toMatch(/\$\{\{\s*steps\.[A-Za-z0-9_-]+\.outputs\.check_order_status\s*\}\}/);
    expect(workflow).toMatch(/\$\{\{\s*steps\.[A-Za-z0-9_-]+\.outputs\.check_ids\s*\}\}/);
  });

  it('shared gate script enforces validator success, check-id order, and optional outputs', () => {
    const script = readFileSync(
      path.join(repoRoot, 'scripts', 'strict-handoff-validator-json-gate.sh'),
      'utf8',
    );

    for (const snippet of gateScriptRequiredSnippets) {
      expect(script).toContain(snippet);
    }
  });
});
