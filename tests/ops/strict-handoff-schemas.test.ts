import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..', '..');
const outputContractPath = path.resolve(
  repoRoot,
  'tests',
  'fixtures',
  'strict-handoff',
  'output-contract.json',
);

type OutputContractFixture = {
  schemaVersion: number;
  summaryTopLevelKeys: string[];
  summaryProfileKeys: string[];
  summaryArtifactKeys: string[];
  summaryCheckKeys: string[];
  summaryJsonSchemaPath: string;
  summaryExamplePath: string;
  validStages: string[];
  completionHintTopLevelKeys: string[];
  completionHintProfileKeys: string[];
  completionHintsJsonSchemaPath: string;
  completionHintsExamplePath: string;
  validatorOutputContractPath: string;
};

const outputContract = JSON.parse(
  readFileSync(outputContractPath, 'utf8'),
) as OutputContractFixture;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected object value');
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new Error('expected string[] value');
  }
  return value as string[];
}

describe('strict-handoff json schemas', () => {
  it('summary schema is present and aligned with output-contract keys', () => {
    expect(outputContract.summaryJsonSchemaPath).toBe(
      'tests/fixtures/strict-handoff/summary.schema.json',
    );

    const summarySchemaPath = path.resolve(repoRoot, outputContract.summaryJsonSchemaPath);
    expect(existsSync(summarySchemaPath)).toBe(true);

    const summarySchema = asRecord(JSON.parse(readFileSync(summarySchemaPath, 'utf8')));
    expect(summarySchema.type).toBe('object');
    expect(summarySchema.additionalProperties).toBe(false);

    const summaryRequired = asStringArray(summarySchema.required);
    expect(summaryRequired.sort()).toEqual([...outputContract.summaryTopLevelKeys].sort());

    const summaryProperties = asRecord(summarySchema.properties);
    expect(Object.keys(summaryProperties).sort()).toEqual(
      [...outputContract.summaryTopLevelKeys].sort(),
    );

    const schemaVersion = asRecord(summaryProperties.schemaVersion);
    expect(schemaVersion.const).toBe(outputContract.schemaVersion);

    const stage = asRecord(summaryProperties.stage);
    expect(asStringArray(stage.enum).sort()).toEqual([...outputContract.validStages].sort());

    const profiles = asRecord(summaryProperties.profiles);
    expect(asStringArray(profiles.required).sort()).toEqual(
      [...outputContract.summaryProfileKeys].sort(),
    );
    expect(Object.keys(asRecord(profiles.properties)).sort()).toEqual(
      [...outputContract.summaryProfileKeys].sort(),
    );

    const artifacts = asRecord(summaryProperties.artifacts);
    expect(asStringArray(artifacts.required).sort()).toEqual(
      [...outputContract.summaryArtifactKeys].sort(),
    );
    expect(Object.keys(asRecord(artifacts.properties)).sort()).toEqual(
      [...outputContract.summaryArtifactKeys].sort(),
    );

    const checks = asRecord(summaryProperties.checks);
    expect(asStringArray(checks.required).sort()).toEqual(
      [...outputContract.summaryCheckKeys].sort(),
    );
    expect(Object.keys(asRecord(checks.properties)).sort()).toEqual(
      [...outputContract.summaryCheckKeys].sort(),
    );
  });

  it('completion-hints schema is present and aligned with output-contract keys', () => {
    expect(outputContract.completionHintsJsonSchemaPath).toBe(
      'tests/fixtures/strict-handoff/completion-hints.schema.json',
    );

    const completionSchemaPath = path.resolve(
      repoRoot,
      outputContract.completionHintsJsonSchemaPath,
    );
    expect(existsSync(completionSchemaPath)).toBe(true);

    const completionSchema = asRecord(JSON.parse(readFileSync(completionSchemaPath, 'utf8')));
    expect(completionSchema.type).toBe('object');
    expect(completionSchema.additionalProperties).toBe(false);

    const completionRequired = asStringArray(completionSchema.required);
    expect(completionRequired.sort()).toEqual(
      [...outputContract.completionHintTopLevelKeys].sort(),
    );

    const completionProperties = asRecord(completionSchema.properties);
    expect(Object.keys(completionProperties).sort()).toEqual(
      [...outputContract.completionHintTopLevelKeys].sort(),
    );

    const schemaVersion = asRecord(completionProperties.schemaVersion);
    expect(schemaVersion.const).toBe(outputContract.schemaVersion);

    const command = asRecord(completionProperties.command);
    expect(command.const).toBe('ops:strict-incident-handoff');

    const profiles = asRecord(completionProperties.profiles);
    expect(asStringArray(profiles.required).sort()).toEqual(
      [...outputContract.completionHintProfileKeys].sort(),
    );
    expect(Object.keys(asRecord(profiles.properties)).sort()).toEqual(
      [...outputContract.completionHintProfileKeys].sort(),
    );
  });

  it('example payload fixtures are present and aligned with output-contract key contracts', () => {
    const summaryExamplePath = path.resolve(repoRoot, outputContract.summaryExamplePath);
    const completionExamplePath = path.resolve(repoRoot, outputContract.completionHintsExamplePath);
    const validatorOutputContractPath = path.resolve(
      repoRoot,
      outputContract.validatorOutputContractPath,
    );
    expect(existsSync(summaryExamplePath)).toBe(true);
    expect(existsSync(completionExamplePath)).toBe(true);
    expect(existsSync(validatorOutputContractPath)).toBe(true);

    const summaryExample = asRecord(JSON.parse(readFileSync(summaryExamplePath, 'utf8')));
    expect(Object.keys(summaryExample).sort()).toEqual(
      [...outputContract.summaryTopLevelKeys].sort(),
    );
    expect(outputContract.validStages.includes(String(summaryExample.stage))).toBe(true);

    const completionExample = asRecord(JSON.parse(readFileSync(completionExamplePath, 'utf8')));
    expect(Object.keys(completionExample).sort()).toEqual(
      [...outputContract.completionHintTopLevelKeys].sort(),
    );
    expect(completionExample.command).toBe('ops:strict-incident-handoff');
  });
});
