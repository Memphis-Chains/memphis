/**
 * The systemd unit contract — the corpus and the live generator.
 *
 * The rules live in `src/infra/audit/systemd-unit-rules.ts` and are read
 * by two runners: the gate (`scripts/check-systemd-units.mts`) and this
 * file. The cases live in `tests/fixtures/systemd-unit-contract.json`,
 * so the rules and their corpus can be read apart.
 *
 * The last case here is not in the corpus: it renders the unit the
 * generator would actually write and holds it to the same rules. That is
 * the drift that started this — the unit that was RUNNING and the unit
 * the generator produced said different things, and a gate that reads
 * only files cannot see it.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { findUnitFindings, GENERATED_UNIT_FILE } from '../../src/infra/audit/systemd-unit-rules.js';
import { buildUserServiceUnit } from '../../src/infra/runtime/user-service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const CONTRACT_PATH = join(REPO_ROOT, 'tests/fixtures/systemd-unit-contract.json');

interface ContractCase {
  name: string;
  file: string;
  unitName: string;
  unit: string;
  knownUnits?: Array<{ name: string; text: string }>;
  expectedRules: string[];
}

interface Contract {
  description: string;
  cases: ContractCase[];
}

const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as Contract;

describe('systemd unit contract — the corpus', () => {
  it('the corpus is not empty and every case names the rules it expects', () => {
    expect(contract.cases.length).toBeGreaterThan(0);
    for (const testCase of contract.cases) {
      expect(testCase.name.length).toBeGreaterThan(0);
      expect(Array.isArray(testCase.expectedRules)).toBe(true);
    }
  });

  for (const testCase of contract.cases) {
    it(testCase.name, () => {
      const knownUnitNames = (testCase.knownUnits ?? []).map((unit) => unit.name);
      const knownUnitSources = new Map(
        (testCase.knownUnits ?? []).map((unit) => [unit.name, unit.text]),
      );
      const findings = findUnitFindings({
        file: testCase.file,
        name: testCase.unitName,
        src: testCase.unit,
        knownUnitNames,
        knownUnitSources,
      });
      expect(findings.map((finding) => finding.rule)).toEqual(testCase.expectedRules);
    });
  }
});

describe('systemd unit contract — the unit the generator writes', () => {
  it('the generated unit satisfies every rule', () => {
    const generated = buildUserServiceUnit(REPO_ROOT, {
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'production',
    });
    const findings = findUnitFindings({
      file: GENERATED_UNIT_FILE,
      name: 'memphis.service',
      src: generated,
      knownUnitNames: [],
      knownUnitSources: new Map(),
    });
    expect(findings.map((finding) => `${finding.rule}: ${finding.problem}`)).toEqual([]);
  });

  it('the generated unit carries the start-limit pair in [Unit], where systemd reads it', () => {
    const generated = buildUserServiceUnit(REPO_ROOT, {
      HOME: process.env.HOME ?? '',
      NODE_ENV: 'production',
    });
    const unitSection = generated.split('[Service]')[0] ?? '';
    expect(unitSection).toContain('StartLimitBurst=5');
    expect(unitSection).toContain('StartLimitIntervalSec=300');
    const serviceSection = generated.split('[Service]')[1] ?? '';
    expect(serviceSection).not.toContain('StartLimitBurst=');
    expect(serviceSection).not.toContain('StartLimitIntervalSec=');
  });
});
