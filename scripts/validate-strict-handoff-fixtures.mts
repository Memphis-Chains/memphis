import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';

type OutputContractFixture = {
  summaryJsonSchemaPath: string;
  completionHintsJsonSchemaPath: string;
  summaryExamplePath: string;
  completionHintsExamplePath: string;
};

type ValidationCheckId =
  | 'summaryExampleSchema'
  | 'completionHintsExampleSchema'
  | 'completionHintsCommandSchema'
  | 'summaryCommandSchema';

type ValidationCheckResult = {
  id: ValidationCheckId;
  ok: boolean;
  error: string | null;
};

type ValidationSummary = {
  schemaVersion: 1;
  ok: boolean;
  checks: ValidationCheckResult[];
  error: string | null;
  errors: string[];
};

function usage(): string {
  return [
    'Usage: npm run -s ops:validate-strict-handoff-fixtures -- [--json]',
    '',
    'Options:',
    '  --json   Emit machine-readable summary output',
  ].join('\n');
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function parseJsonOutput(stdout: string, label: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: invalid JSON output (${message})`);
  }
}

function assertJsonPayload(
  validate: ValidateFunction,
  payload: unknown,
  label: string,
  ajv: Ajv2020,
): void {
  if (!validate(payload)) {
    throw new Error(`${label}: ${ajv.errorsText(validate.errors)}`);
  }
}

function runCommand(commandArgs: string[], cwd: string): ReturnType<typeof spawnSync> {
  return spawnSync('npm', commandArgs, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    timeout: 30_000,
  });
}

function runValidationCheck(
  checks: ValidationCheckResult[],
  errors: string[],
  id: ValidationCheckId,
  label: string,
  jsonMode: boolean,
  fn: () => void,
): void {
  try {
    fn();
    checks.push({ id, ok: true, error: null });
    if (!jsonMode) console.log(`[PASS] ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    checks.push({ id, ok: false, error: message });
    errors.push(message);
    if (!jsonMode) console.error(`[FAIL] ${label}: ${message}`);
  }
}

const rawArgs = process.argv.slice(2);
if (rawArgs.includes('--help')) {
  console.log(usage());
  process.exit(0);
}
for (const arg of rawArgs) {
  if (arg !== '--json') {
    console.error(`Unknown option: ${arg}`);
    console.error(usage());
    process.exit(2);
  }
}

const jsonMode = rawArgs.includes('--json');

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(thisDir, '..');
const contractPath = path.resolve(
  repoRoot,
  'tests',
  'fixtures',
  'strict-handoff',
  'output-contract.json',
);
const outputContract = readJsonFile(contractPath) as OutputContractFixture;

const summarySchema = readJsonFile(path.resolve(repoRoot, outputContract.summaryJsonSchemaPath));
const completionSchema = readJsonFile(
  path.resolve(repoRoot, outputContract.completionHintsJsonSchemaPath),
);
const summaryExample = readJsonFile(path.resolve(repoRoot, outputContract.summaryExamplePath));
const completionExample = readJsonFile(
  path.resolve(repoRoot, outputContract.completionHintsExamplePath),
);

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateSummary = ajv.compile(summarySchema);
const validateCompletion = ajv.compile(completionSchema);

const checks: ValidationCheckResult[] = [];
const errors: string[] = [];

runValidationCheck(
  checks,
  errors,
  'summaryExampleSchema',
  'summary example fixture matches summary schema',
  jsonMode,
  () => assertJsonPayload(validateSummary, summaryExample, 'summary fixture schema mismatch', ajv),
);

runValidationCheck(
  checks,
  errors,
  'completionHintsExampleSchema',
  'completion-hints example fixture matches completion-hints schema',
  jsonMode,
  () =>
    assertJsonPayload(
      validateCompletion,
      completionExample,
      'completion-hints fixture schema mismatch',
      ajv,
    ),
);

runValidationCheck(
  checks,
  errors,
  'completionHintsCommandSchema',
  'completion-hints command output matches completion-hints schema',
  jsonMode,
  () => {
    const completionHintsResult = runCommand(
      ['run', '-s', 'ops:strict-incident-handoff', '--', '--completion-hints'],
      repoRoot,
    );
    if (completionHintsResult.status !== 0) {
      throw new Error(
        `completion-hints command failed (status=${String(completionHintsResult.status)}): ${completionHintsResult.stderr}`,
      );
    }
    const completionHintsPayload = parseJsonOutput(
      completionHintsResult.stdout,
      'completion-hints command output',
    );
    assertJsonPayload(
      validateCompletion,
      completionHintsPayload,
      'completion-hints command schema mismatch',
      ajv,
    );
  },
);

runValidationCheck(
  checks,
  errors,
  'summaryCommandSchema',
  'summary command output matches summary schema',
  jsonMode,
  () => {
    const summaryResult = runCommand(
      ['run', '-s', 'ops:strict-incident-handoff', '--', '--json'],
      repoRoot,
    );
    if (summaryResult.status !== 0 && summaryResult.status !== 1) {
      throw new Error(
        `summary command returned unexpected status=${String(summaryResult.status)}: ${summaryResult.stderr}`,
      );
    }
    const summaryPayload = parseJsonOutput(
      summaryResult.stdout,
      'strict-handoff summary command output',
    );
    assertJsonPayload(validateSummary, summaryPayload, 'summary command schema mismatch', ajv);
  },
);

const summary: ValidationSummary = {
  schemaVersion: 1,
  ok: errors.length === 0,
  checks,
  error: errors.length > 0 ? errors[0] : null,
  errors,
};

if (jsonMode) {
  console.log(JSON.stringify(summary, null, 2));
} else if (summary.ok) {
  console.log('[PASS] strict-handoff fixture/schema validation completed');
} else {
  console.error('[FAIL] strict-handoff fixture/schema validation failed');
}

process.exit(summary.ok ? 0 : 1);
