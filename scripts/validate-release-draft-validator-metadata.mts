import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';

type ValidationSummary = {
  schemaVersion: 1;
  ok: boolean;
  metadataPath: string;
  schemaPath: string;
  error: string | null;
};

type Options = {
  json: boolean;
  metadataPath: string;
  schemaPath: string;
};

function usage(): string {
  return [
    'Usage: npm run -s ops:validate-release-draft-validator-metadata -- [--metadata-path <path>] [--schema-path <path>] [--json]',
    '',
    'Options:',
    '  --metadata-path <path>  Path to validator metadata JSON payload',
    '                          (default: release-dist/validator-metadata.json)',
    '  --schema-path <path>    Path to validator metadata JSON schema',
    '                          (default: tests/fixtures/release-draft/validator-metadata.schema.json)',
    '  --json                  Emit machine-readable summary output',
  ].join('\n');
}

function failUsage(message: string): never {
  console.error(message);
  console.error(usage());
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    json: false,
    metadataPath: 'release-dist/validator-metadata.json',
    schemaPath: 'tests/fixtures/release-draft/validator-metadata.schema.json',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--metadata-path') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) failUsage('Missing value for --metadata-path');
      options.metadataPath = value;
      i += 1;
      continue;
    }
    if (arg === '--schema-path') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) failUsage('Missing value for --schema-path');
      options.schemaPath = value;
      i += 1;
      continue;
    }
    if (arg === '--help') {
      console.log(usage());
      process.exit(0);
    }
    failUsage(`Unknown option: ${arg}`);
  }

  return options;
}

function asErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readJsonFile(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, 'utf8'));
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

const options = parseArgs(process.argv.slice(2));
const metadataPath = path.resolve(process.cwd(), options.metadataPath);
const schemaPath = path.resolve(process.cwd(), options.schemaPath);

let summary: ValidationSummary;
try {
  const schema = readJsonFile(schemaPath);
  const payload = readJsonFile(metadataPath);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  assertJsonPayload(validate, payload, 'validator metadata schema mismatch', ajv);

  summary = {
    schemaVersion: 1,
    ok: true,
    metadataPath: options.metadataPath,
    schemaPath: options.schemaPath,
    error: null,
  };
} catch (error) {
  summary = {
    schemaVersion: 1,
    ok: false,
    metadataPath: options.metadataPath,
    schemaPath: options.schemaPath,
    error: asErrorMessage(error),
  };
}

if (options.json) {
  console.log(JSON.stringify(summary, null, 2));
} else if (summary.ok) {
  console.log(`[PASS] validator metadata matches schema (${options.metadataPath})`);
} else {
  console.error(`[FAIL] validator metadata schema validation failed: ${summary.error}`);
}

process.exit(summary.ok ? 0 : 1);
