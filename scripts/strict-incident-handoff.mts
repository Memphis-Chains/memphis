import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type HandoffStage = 'preflight' | 'export' | 'verify';

interface ExportCommandOutput {
  ok: boolean;
  output?: string;
  manifest?: string | null;
  signingKeyId?: string | null;
  error?: string;
}

interface VerifyCommandOutput {
  ok: boolean;
  errors?: string[];
  error?: string;
  checks?: Record<string, unknown>;
  chainEvent?: {
    written?: boolean;
    index?: number;
    hash?: string;
  };
  bundlePath?: string;
  manifestPath?: string;
}

interface HandoffSummary {
  schemaVersion: 1;
  ok: boolean;
  stage: HandoffStage;
  profiles: {
    export: 'strict-handoff';
    verify: 'trust-root-strict';
  };
  artifacts: {
    bundlePath: string | null;
    manifestPath: string | null;
  };
  checks: {
    signatureVerified: boolean | null;
    keyBundleSignatureValid: boolean | null;
    keyBundleTrustRootMatch: boolean | null;
    cognitiveSummaryRequirementSatisfied: boolean | null;
    chainEventWritten: boolean | null;
    chainEventIndex: number | null;
    chainEventHash: string | null;
  };
  error: string | null;
  errors: string[];
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: string | null;
}

const VALUE_FLAGS = new Set([
  '--status-url',
  '--audit-path',
  '--out',
  '--manifest-out',
  '--signing-key-path',
  '--signing-key-pem',
  '--signing-key-pem-base64',
  '--signing-key-id',
  '--encryption-passphrase',
  '--encryption-passphrase-base64',
  '--encryption-passphrase-file',
  '--encrypted-bundle-out',
  '--encrypted-manifest-out',
  '--cognitive-report-limit',
  '--cognitive-journal-path',
  '--retention-count',
  '--retention-days',
  '--audit-lines',
  '--public-key-bundle-path',
  '--trust-root-path',
  '--expected-key-id',
  '--decryption-passphrase',
  '--decryption-passphrase-base64',
  '--decryption-passphrase-file',
  '--chain-event-retry-count',
  '--chain-event-retry-backoff-ms',
]);
const BOOLEAN_FLAGS = new Set([
  '--json',
  '--completion-hints',
  '--preflight-only',
  '--help',
  '-h',
  '--require-encrypted-artifacts',
  '--no-redact',
  '--include-cognitive-summaries',
]);
const REQUIRED_VALUE_FLAGS = ['--public-key-bundle-path', '--signing-key-id|--expected-key-id'];
const REQUIRED_SIGNING_KEY_FLAGS = [
  '--signing-key-path',
  '--signing-key-pem',
  '--signing-key-pem-base64',
];
const OPTIONAL_VALUE_FLAGS = [
  '--status-url',
  '--audit-path',
  '--out',
  '--manifest-out',
  '--signing-key-path',
  '--signing-key-pem',
  '--signing-key-pem-base64',
  '--signing-key-id',
  '--expected-key-id',
  '--public-key-bundle-path',
  '--trust-root-path',
  '--encryption-passphrase',
  '--encryption-passphrase-base64',
  '--encryption-passphrase-file',
  '--encrypted-bundle-out',
  '--encrypted-manifest-out',
  '--cognitive-report-limit',
  '--cognitive-journal-path',
  '--retention-count',
  '--retention-days',
  '--audit-lines',
  '--decryption-passphrase',
  '--decryption-passphrase-base64',
  '--decryption-passphrase-file',
  '--chain-event-retry-count',
  '--chain-event-retry-backoff-ms',
];
const OPTIONAL_BOOLEAN_FLAGS = [
  '--require-encrypted-artifacts',
  '--no-redact',
  '--include-cognitive-summaries',
  '--preflight-only',
  '--json',
  '--completion-hints',
];
const EXPORT_PROFILE: HandoffSummary['profiles']['export'] = 'strict-handoff';
const VERIFY_PROFILE: HandoffSummary['profiles']['verify'] = 'trust-root-strict';

function parseArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function renderHelp(): string {
  return [
    'Usage: npm run -s ops:strict-incident-handoff -- [options]',
    '',
    'Runs strict incident handoff workflow:',
    '  1) export with --profile strict-handoff',
    '  2) verify with --profile trust-root-strict',
    '',
    'Required:',
    '  --signing-key-path|--signing-key-pem|--signing-key-pem-base64',
    '  --signing-key-id (or --expected-key-id)',
    '  --public-key-bundle-path',
    '  --trust-root-path (or MEMPHIS_TRUST_ROOT_PATH)',
    '',
    'Optional:',
    '  --status-url <url>',
    '  --audit-path <path>',
    '  --out <path>',
    '  --manifest-out <path>',
    '  --expected-key-id <id>',
    '  --decryption-passphrase <value>',
    '  --chain-event-retry-count <n>',
    '  --chain-event-retry-backoff-ms <n>',
    '  --preflight-only               Validate strict prerequisites and exit without export/verify',
    '  --completion-hints',
    '  --json',
    '  -h, --help',
    '',
    'Env defaults:',
    '  MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_PATH / _PEM / _PEM_BASE64',
    '  MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_ID',
    '  MEMPHIS_INCIDENT_BUNDLE_PUBLIC_KEY_BUNDLE_PATH',
    '  MEMPHIS_TRUST_ROOT_PATH',
  ].join('\n');
}

function printCompletionHints(): void {
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        command: 'ops:strict-incident-handoff',
        profiles: {
          export: EXPORT_PROFILE,
          verify: VERIFY_PROFILE,
        },
        requiredFlags: REQUIRED_VALUE_FLAGS,
        requiredSigningKeyFlags: REQUIRED_SIGNING_KEY_FLAGS,
        optionalValueFlags: OPTIONAL_VALUE_FLAGS,
        optionalBooleanFlags: OPTIONAL_BOOLEAN_FLAGS,
        policyEnvVars: [
          'MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_PATH',
          'MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_PEM',
          'MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_PEM_BASE64',
          'MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_ID',
          'MEMPHIS_INCIDENT_BUNDLE_PUBLIC_KEY_BUNDLE_PATH',
          'MEMPHIS_TRUST_ROOT_PATH',
          'MEMPHIS_INCIDENT_BUNDLE_ENCRYPTION_PASSPHRASE',
          'MEMPHIS_INCIDENT_BUNDLE_ENCRYPTION_PASSPHRASE_BASE64',
          'MEMPHIS_INCIDENT_BUNDLE_ENCRYPTION_PASSPHRASE_FILE',
          'MEMPHIS_INCIDENT_BUNDLE_DECRYPTION_PASSPHRASE',
          'MEMPHIS_INCIDENT_BUNDLE_DECRYPTION_PASSPHRASE_BASE64',
          'MEMPHIS_INCIDENT_BUNDLE_DECRYPTION_PASSPHRASE_FILE',
        ],
      },
      null,
      2,
    ),
  );
}

function validateArgs(): void {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--') continue;
    if (!token.startsWith('-')) throw new Error(`unexpected positional argument: ${token}`);
    if (BOOLEAN_FLAGS.has(token)) continue;
    if (VALUE_FLAGS.has(token)) {
      const value = args[i + 1];
      if (!value || value.startsWith('-')) {
        throw new Error(`missing value for ${token}`);
      }
      i += 1;
      continue;
    }
    throw new Error(`unknown argument: ${token}`);
  }
}

function addOptionalValueFlag(target: string[], flag: string): void {
  const value = parseArg(flag);
  if (value !== null) target.push(flag, value);
}

function addOptionalBoolFlag(target: string[], flag: string): void {
  if (hasFlag(flag)) target.push(flag);
}

function resolveRepoRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return resolve(moduleDir, '..');
}

function runOpsCommand(repoRoot: string, args: string[]): CommandResult {
  const result = spawnSync('npm', ['run', '-s', ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error instanceof Error ? result.error.message : null,
  };
}

function parseJsonObject(raw: string, commandName: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new Error(`${commandName} emitted empty output`);
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${commandName} output must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function boolOrNull(input: unknown): boolean | null {
  return typeof input === 'boolean' ? input : null;
}

function numberOrNull(input: unknown): number | null {
  return typeof input === 'number' && Number.isFinite(input) ? input : null;
}

function stringOrNull(input: unknown): string | null {
  return typeof input === 'string' && input.length > 0 ? input : null;
}

function buildSummary(init: {
  ok: boolean;
  stage: HandoffStage;
  bundlePath?: string | null;
  manifestPath?: string | null;
  checks?: Record<string, unknown>;
  chainEvent?: VerifyCommandOutput['chainEvent'];
  error?: string | null;
  errors?: string[];
}): HandoffSummary {
  return {
    schemaVersion: 1,
    ok: init.ok,
    stage: init.stage,
    profiles: {
      export: EXPORT_PROFILE,
      verify: VERIFY_PROFILE,
    },
    artifacts: {
      bundlePath: init.bundlePath ?? null,
      manifestPath: init.manifestPath ?? null,
    },
    checks: {
      signatureVerified: boolOrNull(init.checks?.signatureVerified),
      keyBundleSignatureValid: boolOrNull(init.checks?.keyBundleSignatureValid),
      keyBundleTrustRootMatch: boolOrNull(init.checks?.keyBundleTrustRootMatch),
      cognitiveSummaryRequirementSatisfied: boolOrNull(
        init.checks?.cognitiveSummaryRequirementSatisfied,
      ),
      chainEventWritten: boolOrNull(init.chainEvent?.written),
      chainEventIndex: numberOrNull(init.chainEvent?.index),
      chainEventHash: stringOrNull(init.chainEvent?.hash),
    },
    error: init.error ?? null,
    errors: init.errors ?? [],
  };
}

function printHumanSummary(summary: HandoffSummary): void {
  if (summary.ok) {
    if (summary.stage === 'preflight') {
      console.log('[PASS] strict incident handoff preflight checks passed');
      return;
    }
    console.log('[PASS] strict incident handoff complete');
    console.log(`bundle=${summary.artifacts.bundlePath ?? 'unknown'}`);
    console.log(`manifest=${summary.artifacts.manifestPath ?? 'unknown'}`);
    console.log(
      `checks signatureVerified=${summary.checks.signatureVerified} keyBundleSignatureValid=${summary.checks.keyBundleSignatureValid} keyBundleTrustRootMatch=${summary.checks.keyBundleTrustRootMatch} cognitiveSummaryRequirementSatisfied=${summary.checks.cognitiveSummaryRequirementSatisfied} chainEventWritten=${summary.checks.chainEventWritten}`,
    );
    if (summary.checks.chainEventIndex !== null || summary.checks.chainEventHash !== null) {
      console.log(
        `chainEvent index=${summary.checks.chainEventIndex ?? 'n/a'} hash=${summary.checks.chainEventHash ?? 'n/a'}`,
      );
    }
    return;
  }

  console.error('[FAIL] strict incident handoff failed');
  console.error(`stage=${summary.stage}`);
  if (summary.error) console.error(`error=${summary.error}`);
  if (summary.errors.length > 0) console.error(`details=${summary.errors.join('; ')}`);
}

function emitSummary(summary: HandoffSummary, json: boolean): never {
  if (json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printHumanSummary(summary);
  }
  process.exit(summary.ok ? 0 : 1);
}

function resolveSigningKeyProvided(): boolean {
  return Boolean(
    parseArg('--signing-key-path') ??
    parseArg('--signing-key-pem') ??
    parseArg('--signing-key-pem-base64') ??
    process.env.MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_PATH ??
    process.env.MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_PEM ??
    process.env.MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_PEM_BASE64,
  );
}

function resolvePublicKeyBundlePath(): string | null {
  const raw =
    parseArg('--public-key-bundle-path') ??
    process.env.MEMPHIS_INCIDENT_BUNDLE_PUBLIC_KEY_BUNDLE_PATH ??
    null;
  return raw ? resolve(raw) : null;
}

function resolveTrustRootPath(): string {
  const raw = parseArg('--trust-root-path') ?? process.env.MEMPHIS_TRUST_ROOT_PATH;
  if (raw && raw.length > 0) return resolve(raw);
  return resolve('./config/trust_root.json');
}

function resolveExpectedKeyIdFallback(): string | null {
  return (
    parseArg('--expected-key-id') ??
    parseArg('--signing-key-id') ??
    process.env.MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_ID ??
    null
  );
}

function collectPreflightErrors(): string[] {
  const errors: string[] = [];

  if (!resolveSigningKeyProvided()) {
    errors.push(
      'strict handoff requires signing key input (--signing-key-path|--signing-key-pem|--signing-key-pem-base64 or matching env)',
    );
  }

  const expectedKeyId = resolveExpectedKeyIdFallback();
  if (!expectedKeyId) {
    errors.push('strict handoff requires --signing-key-id (or --expected-key-id)');
  }

  const publicKeyBundlePath = resolvePublicKeyBundlePath();
  if (!publicKeyBundlePath) {
    errors.push(
      'strict handoff requires --public-key-bundle-path (or MEMPHIS_INCIDENT_BUNDLE_PUBLIC_KEY_BUNDLE_PATH)',
    );
  } else if (!existsSync(publicKeyBundlePath)) {
    errors.push(`public key bundle not found: ${publicKeyBundlePath}`);
  }

  const trustRootPath = resolveTrustRootPath();
  if (!existsSync(trustRootPath)) {
    errors.push(
      `trust root manifest not found: ${trustRootPath} (set --trust-root-path or MEMPHIS_TRUST_ROOT_PATH)`,
    );
  }

  return errors;
}

function buildExportArgs(): string[] {
  const args = ['ops:export-incident-bundle', '--', '--profile', EXPORT_PROFILE];
  addOptionalValueFlag(args, '--status-url');
  addOptionalValueFlag(args, '--audit-path');
  addOptionalValueFlag(args, '--out');
  addOptionalValueFlag(args, '--manifest-out');
  addOptionalValueFlag(args, '--signing-key-path');
  addOptionalValueFlag(args, '--signing-key-pem');
  addOptionalValueFlag(args, '--signing-key-pem-base64');
  addOptionalValueFlag(args, '--signing-key-id');
  addOptionalValueFlag(args, '--encryption-passphrase');
  addOptionalValueFlag(args, '--encryption-passphrase-base64');
  addOptionalValueFlag(args, '--encryption-passphrase-file');
  addOptionalValueFlag(args, '--encrypted-bundle-out');
  addOptionalValueFlag(args, '--encrypted-manifest-out');
  addOptionalValueFlag(args, '--cognitive-report-limit');
  addOptionalValueFlag(args, '--cognitive-journal-path');
  addOptionalValueFlag(args, '--retention-count');
  addOptionalValueFlag(args, '--retention-days');
  addOptionalValueFlag(args, '--audit-lines');
  addOptionalBoolFlag(args, '--require-encrypted-artifacts');
  addOptionalBoolFlag(args, '--no-redact');
  addOptionalBoolFlag(args, '--include-cognitive-summaries');
  return args;
}

function buildVerifyArgs(options: {
  manifestPath: string;
  expectedKeyId: string | null;
}): string[] {
  const args = [
    'ops:verify-incident-manifest',
    '--',
    '--profile',
    VERIFY_PROFILE,
    '--manifest-path',
    options.manifestPath,
    '--public-key-bundle-path',
    resolvePublicKeyBundlePath() ?? '',
    '--trust-root-path',
    resolveTrustRootPath(),
  ];

  if (options.expectedKeyId) args.push('--expected-key-id', options.expectedKeyId);
  addOptionalValueFlag(args, '--decryption-passphrase');
  addOptionalValueFlag(args, '--decryption-passphrase-base64');
  addOptionalValueFlag(args, '--decryption-passphrase-file');
  addOptionalValueFlag(args, '--chain-event-retry-count');
  addOptionalValueFlag(args, '--chain-event-retry-backoff-ms');
  return args;
}

function parseExportResult(commandResult: CommandResult): ExportCommandOutput {
  if (commandResult.error) {
    return { ok: false, error: commandResult.error };
  }
  try {
    return parseJsonObject(
      commandResult.stdout,
      'ops:export-incident-bundle',
    ) as ExportCommandOutput;
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `${error.message}; stderr=${commandResult.stderr.trim() || 'empty'}`
          : String(error),
    };
  }
}

function parseVerifyResult(commandResult: CommandResult): VerifyCommandOutput {
  if (commandResult.error) {
    return { ok: false, error: commandResult.error };
  }
  try {
    return parseJsonObject(
      commandResult.stdout,
      'ops:verify-incident-manifest',
    ) as VerifyCommandOutput;
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `${error.message}; stderr=${commandResult.stderr.trim() || 'empty'}`
          : String(error),
    };
  }
}

function main(): never {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(renderHelp());
    process.exit(0);
  }
  if (hasFlag('--completion-hints')) {
    printCompletionHints();
    process.exit(0);
  }
  validateArgs();

  const json = hasFlag('--json');
  const preflightErrors = collectPreflightErrors();
  if (preflightErrors.length > 0) {
    return emitSummary(
      buildSummary({
        ok: false,
        stage: 'preflight',
        error: 'strict handoff preflight failed',
        errors: preflightErrors,
      }),
      json,
    );
  }
  if (hasFlag('--preflight-only')) {
    return emitSummary(
      buildSummary({
        ok: true,
        stage: 'preflight',
      }),
      json,
    );
  }

  const repoRoot = resolveRepoRoot();
  const exportRun = runOpsCommand(repoRoot, buildExportArgs());
  const exportParsed = parseExportResult(exportRun);
  if (exportRun.status !== 0 || !exportParsed.ok) {
    return emitSummary(
      buildSummary({
        ok: false,
        stage: 'export',
        bundlePath: stringOrNull(exportParsed.output),
        manifestPath: stringOrNull(exportParsed.manifest ?? null),
        error:
          exportParsed.error ??
          `export command failed (status=${exportRun.status ?? 'null'}): ${exportRun.stderr.trim() || 'unknown error'}`,
      }),
      json,
    );
  }

  const manifestPath = stringOrNull(exportParsed.manifest);
  const bundlePath = stringOrNull(exportParsed.output);
  if (!manifestPath) {
    return emitSummary(
      buildSummary({
        ok: false,
        stage: 'export',
        bundlePath,
        error: 'export completed without manifest path',
      }),
      json,
    );
  }

  const expectedKeyId =
    stringOrNull(parseArg('--expected-key-id')) ?? stringOrNull(exportParsed.signingKeyId);
  const verifyRun = runOpsCommand(repoRoot, buildVerifyArgs({ manifestPath, expectedKeyId }));
  const verifyParsed = parseVerifyResult(verifyRun);
  if (verifyRun.status !== 0 || !verifyParsed.ok) {
    const verifyErrors =
      Array.isArray(verifyParsed.errors) && verifyParsed.errors.length > 0
        ? verifyParsed.errors
        : [];
    return emitSummary(
      buildSummary({
        ok: false,
        stage: 'verify',
        bundlePath: stringOrNull(verifyParsed.bundlePath) ?? bundlePath,
        manifestPath: stringOrNull(verifyParsed.manifestPath) ?? manifestPath,
        checks: verifyParsed.checks,
        chainEvent: verifyParsed.chainEvent,
        error:
          verifyParsed.error ??
          `verify command failed (status=${verifyRun.status ?? 'null'}): ${verifyRun.stderr.trim() || 'unknown error'}`,
        errors: verifyErrors,
      }),
      json,
    );
  }

  return emitSummary(
    buildSummary({
      ok: true,
      stage: 'verify',
      bundlePath: stringOrNull(verifyParsed.bundlePath) ?? bundlePath,
      manifestPath: stringOrNull(verifyParsed.manifestPath) ?? manifestPath,
      checks: verifyParsed.checks,
      chainEvent: verifyParsed.chainEvent,
    }),
    json,
  );
}

try {
  main();
} catch (error) {
  const json = hasFlag('--json');
  emitSummary(
    buildSummary({
      ok: false,
      stage: 'preflight',
      error: error instanceof Error ? error.message : String(error),
    }),
    json,
  );
}
