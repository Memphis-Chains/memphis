import { spawnSync } from 'node:child_process';
import { createPrivateKey, createPublicKey, sign as signDetached } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getChainPath } from '../src/config/paths.js';
import { encryptBlob, sha256Hex } from './lib/encrypted-blob.mts';

type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

interface IncidentBundle {
  schemaVersion: number;
  generatedAt: string;
  status: {
    ok: boolean;
    url: string;
    httpStatus: number | null;
    payload?: JsonValue;
    error?: string;
  };
  securityAudit: {
    path: string;
    tailLines: JsonValue[];
  };
  drill: {
    ok: boolean;
    result?: JsonValue;
    error?: string;
  };
  cognitiveReports?: CognitiveReportSnapshot;
}

type CognitiveReportKind = 'insight' | 'categorize' | 'reflection';

interface CognitiveReportSummary {
  index: number | null;
  timestamp: string | null;
  hash: string | null;
  reportType: CognitiveReportKind;
  dataType: string;
  schemaVersion: number | null;
  source: string | null;
  generatedAt: string | null;
  input: string | null;
  path: string;
}

interface CognitiveReportSnapshot {
  schemaVersion: 1;
  journalPath: string;
  limit: number;
  count: number;
  reports: CognitiveReportSummary[];
}

interface CognitiveReportManifestIntegrity {
  included: boolean;
  count: number;
  digestSha256: string | null;
  schemaVersion: number | null;
  limit: number | null;
  journalPath: string | null;
}

interface IncidentBundleManifest {
  schemaVersion: number;
  generatedAt: string;
  bundle: {
    path: string;
    sha256: string;
    bytes: number;
  };
  redaction: {
    enabled: boolean;
    marker: string;
  };
  retention: {
    count: number;
    days: number;
    prunedFiles: string[];
  };
  drill: {
    ok: boolean;
    schemaVersion: number | null;
  };
  cognitiveReports: CognitiveReportManifestIntegrity;
  encryptedArtifacts?: {
    schemaVersion: 1;
    format: 'memphis.encrypted-blob.v1';
    algorithm: 'aes-256-gcm';
    kdf: 'scrypt';
    bundle: EncryptedArtifactManifestDescriptor;
    manifest?: {
      path: string;
    };
  };
  signature?: {
    algorithm: 'ed25519';
    value: string;
    payloadSha256: string;
    keyFingerprint: string;
    keyId?: string;
  };
}

interface SigningKeySpec {
  source: 'path' | 'env-pem' | 'env-pem-base64';
  privateKeyPem: string;
  keyId: string | null;
}

interface EncryptionPassphraseSpec {
  source: 'arg' | 'arg-base64' | 'arg-file' | 'env' | 'env-base64' | 'env-file';
  passphrase: string;
}

interface EncryptedArtifactManifestDescriptor {
  path: string;
  sha256: string;
  bytes: number;
}

type ExportProfileName = 'financial-strict' | 'forensics-lite' | 'strict-handoff';

interface ExportProfileDefaults {
  redactSensitive: boolean;
  requireEncryptedArtifacts: boolean;
  includeCognitiveSummaries: boolean;
  writeManifest: boolean;
  auditLines: number;
  retentionCount: number;
  retentionDays: number;
}

const REDACTED = '[REDACTED]';
const INCIDENT_BUNDLE_PREFIX = 'incident-bundle-';
const MANIFEST_SUFFIX = '.manifest.json';
const EXPORT_PROFILE_VALUES: ExportProfileName[] = [
  'financial-strict',
  'forensics-lite',
  'strict-handoff',
];
const EXPORT_PROFILE_ENV = 'MEMPHIS_INCIDENT_BUNDLE_EXPORT_PROFILE';
const COGNITIVE_REPORT_TYPE_MAP = {
  insight_report: 'insight',
  categorize_report: 'categorize',
  reflection_report: 'reflection',
} as const satisfies Record<string, CognitiveReportKind>;
const COGNITIVE_INCLUDE_ENV = 'MEMPHIS_INCIDENT_INCLUDE_COGNITIVE_SUMMARIES';
const COGNITIVE_LIMIT_ENV = 'MEMPHIS_INCIDENT_COGNITIVE_REPORT_LIMIT';
const COGNITIVE_JOURNAL_PATH_ENV = 'MEMPHIS_INCIDENT_COGNITIVE_JOURNAL_PATH';
const REDACTABLE_KEY_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /passphrase/i,
  /authorization/i,
  /api[-_]?key/i,
  /private[-_]?key/i,
  /cookie/i,
  /pepper/i,
];
const REDACTABLE_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9]{10,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi,
];

function parseArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parseBool(raw: string | undefined, fallback = false): boolean {
  if (typeof raw !== 'string') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

function parseIntArg(flag: string, fallback: number, envName?: string): number {
  const raw = parseArg(flag);
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const envRaw = envName ? process.env[envName] : undefined;
  if (typeof envRaw === 'string' && envRaw.trim().length > 0) {
    const envParsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(envParsed) && envParsed > 0) return envParsed;
  }

  return fallback;
}

function resolveExportProfileName(): ExportProfileName | null {
  const raw = parseArg('--profile') ?? process.env[EXPORT_PROFILE_ENV] ?? null;
  if (!raw) return null;
  if (raw === 'financial-strict' || raw === 'forensics-lite' || raw === 'strict-handoff')
    return raw;
  throw new Error(
    `unsupported export profile: ${raw}; expected one of financial-strict, forensics-lite, strict-handoff`,
  );
}

function resolveExportProfileDefaults(profile: ExportProfileName | null): ExportProfileDefaults {
  if (profile === 'financial-strict') {
    return {
      redactSensitive: true,
      requireEncryptedArtifacts: true,
      includeCognitiveSummaries: false,
      writeManifest: true,
      auditLines: 100,
      retentionCount: 60,
      retentionDays: 30,
    };
  }
  if (profile === 'forensics-lite') {
    return {
      redactSensitive: true,
      requireEncryptedArtifacts: false,
      includeCognitiveSummaries: false,
      writeManifest: true,
      auditLines: 75,
      retentionCount: 30,
      retentionDays: 14,
    };
  }
  if (profile === 'strict-handoff') {
    return {
      redactSensitive: true,
      requireEncryptedArtifacts: false,
      includeCognitiveSummaries: true,
      writeManifest: true,
      auditLines: 100,
      retentionCount: 45,
      retentionDays: 21,
    };
  }
  return {
    redactSensitive: true,
    requireEncryptedArtifacts: false,
    includeCognitiveSummaries: false,
    writeManifest: false,
    auditLines: 50,
    retentionCount: 20,
    retentionDays: 14,
  };
}

function parseOptionalBool(raw: string | undefined): boolean | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  return parseBool(raw, false);
}

function renderHelp(): string {
  return [
    'Usage: npm run -s ops:export-incident-bundle -- [options]',
    '',
    'Options:',
    '  --profile <name>                Export policy profile: financial-strict|forensics-lite|strict-handoff',
    '  --include-cognitive-summaries   Embed latest journal cognitive report summaries in bundle',
    '  --cognitive-report-limit <n>    Max cognitive summaries to include (default: 10)',
    '  --cognitive-journal-path <path> Override journal chain path for cognitive summaries',
    '  --completion-hints              Print machine-readable profile/completion hints as JSON',
    '  -h, --help                      Show this help message',
    '',
    'Profile env variables:',
    `  ${EXPORT_PROFILE_ENV}=financial-strict|forensics-lite|strict-handoff`,
    '  MEMPHIS_INCIDENT_REQUIRE_ENCRYPTED_ARTIFACTS=true|false',
    `  ${COGNITIVE_INCLUDE_ENV}=true|false`,
    `  ${COGNITIVE_LIMIT_ENV}=<positive integer>`,
    `  ${COGNITIVE_JOURNAL_PATH_ENV}=<path>`,
  ].join('\n');
}

function printCompletionHints(): void {
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        command: 'ops:export-incident-bundle',
        profiles: EXPORT_PROFILE_VALUES,
        profileFlag: '--profile',
        profileEnv: EXPORT_PROFILE_ENV,
        policyEnvVars: [
          'MEMPHIS_INCIDENT_REQUIRE_ENCRYPTED_ARTIFACTS',
          COGNITIVE_INCLUDE_ENV,
          COGNITIVE_LIMIT_ENV,
          COGNITIVE_JOURNAL_PATH_ENV,
        ],
      },
      null,
      2,
    ),
  );
}

function tailLines(input: string, count: number): string[] {
  const lines = input
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.slice(Math.max(0, lines.length - count));
}

function parseJsonLine(line: string): JsonValue {
  try {
    return JSON.parse(line) as JsonValue;
  } catch {
    return { raw: line };
  }
}

function maybeRedactString(input: string): string {
  let output = input;
  for (const pattern of REDACTABLE_VALUE_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }
  return output;
}

function shouldRedactKey(key: string): boolean {
  for (const pattern of REDACTABLE_KEY_PATTERNS) {
    if (pattern.test(key)) return true;
  }
  return false;
}

function redactJson(value: JsonValue, keyHint?: string): JsonValue {
  if (keyHint && shouldRedactKey(keyHint)) return REDACTED;
  if (typeof value === 'string') return maybeRedactString(value);
  if (Array.isArray(value)) return value.map((item) => redactJson(item));
  if (!value || typeof value !== 'object') return value;

  const out: { [k: string]: JsonValue } = {};
  for (const [key, nested] of Object.entries(value)) {
    out[key] = redactJson(nested, key);
  }
  return out;
}

function resolveSigningKeySpec(): SigningKeySpec | null {
  const pathRaw =
    parseArg('--signing-key-path') ?? process.env.MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_PATH ?? null;
  const pemRaw =
    parseArg('--signing-key-pem') ?? process.env.MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_PEM ?? null;
  const pemBase64Raw =
    parseArg('--signing-key-pem-base64') ??
    process.env.MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_PEM_BASE64 ??
    null;
  const keyId =
    parseArg('--signing-key-id') ?? process.env.MEMPHIS_INCIDENT_BUNDLE_SIGNING_KEY_ID ?? null;

  const presentSources = [Boolean(pathRaw), Boolean(pemRaw), Boolean(pemBase64Raw)].filter(
    Boolean,
  ).length;
  if (presentSources > 1) {
    throw new Error(
      'multiple signing key sources provided; use exactly one of --signing-key-path, --signing-key-pem, --signing-key-pem-base64',
    );
  }

  if (pathRaw) {
    return {
      source: 'path',
      privateKeyPem: readFileSync(resolve(pathRaw), 'utf8'),
      keyId,
    };
  }
  if (pemRaw) {
    return {
      source: 'env-pem',
      privateKeyPem: pemRaw,
      keyId,
    };
  }
  if (pemBase64Raw) {
    return {
      source: 'env-pem-base64',
      privateKeyPem: Buffer.from(pemBase64Raw, 'base64').toString('utf8'),
      keyId,
    };
  }
  return null;
}

function resolveEncryptionPassphraseSpec(): EncryptionPassphraseSpec | null {
  const argRaw = parseArg('--encryption-passphrase');
  const argBase64 = parseArg('--encryption-passphrase-base64');
  const argFile = parseArg('--encryption-passphrase-file');
  const envRaw = process.env.MEMPHIS_INCIDENT_BUNDLE_ENCRYPTION_PASSPHRASE ?? null;
  const envBase64 = process.env.MEMPHIS_INCIDENT_BUNDLE_ENCRYPTION_PASSPHRASE_BASE64 ?? null;
  const envFile = process.env.MEMPHIS_INCIDENT_BUNDLE_ENCRYPTION_PASSPHRASE_FILE ?? null;

  const declared = [
    ['arg', argRaw] as const,
    ['arg-base64', argBase64] as const,
    ['arg-file', argFile] as const,
    ['env', envRaw] as const,
    ['env-base64', envBase64] as const,
    ['env-file', envFile] as const,
  ].filter((entry) => typeof entry[1] === 'string' && entry[1].trim().length > 0);

  if (declared.length === 0) return null;
  if (declared.length > 1) {
    throw new Error(
      'multiple encryption passphrase sources provided; use exactly one of --encryption-passphrase, --encryption-passphrase-base64, --encryption-passphrase-file (or matching env vars)',
    );
  }

  const [source, value] = declared[0];
  if (!value) return null;
  if (source === 'arg-base64' || source === 'env-base64') {
    return { source, passphrase: Buffer.from(value, 'base64').toString('utf8') };
  }
  if (source === 'arg-file' || source === 'env-file') {
    return { source, passphrase: readFileSync(resolve(value), 'utf8').trim() };
  }
  return { source, passphrase: value };
}

function inferManifestPath(bundlePath: string): string {
  if (bundlePath.endsWith('.json')) return bundlePath.slice(0, -'.json'.length) + MANIFEST_SUFFIX;
  return `${bundlePath}${MANIFEST_SUFFIX}`;
}

function isIncidentBundleFile(name: string): boolean {
  return (
    name.startsWith(INCIDENT_BUNDLE_PREFIX) &&
    name.endsWith('.json') &&
    !name.endsWith(MANIFEST_SUFFIX)
  );
}

function manifestNameForBundle(bundleName: string): string {
  if (bundleName.endsWith('.json')) return bundleName.slice(0, -'.json'.length) + MANIFEST_SUFFIX;
  return `${bundleName}${MANIFEST_SUFFIX}`;
}

function encryptedCompanionPath(filePath: string): string {
  return `${filePath}.enc`;
}

function safeUnlink(filePath: string): boolean {
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function pruneIncidentBundleHistory(
  outPath: string,
  retentionCount: number,
  retentionDays: number,
): string[] {
  const outDir = dirname(outPath);
  let names: string[] = [];
  try {
    names = readdirSync(outDir);
  } catch {
    return [];
  }

  const nowMs = Date.now();
  const maxAgeMs = retentionDays * 24 * 60 * 60 * 1000;
  const bundles = names
    .filter(isIncidentBundleFile)
    .map((name) => {
      const fullPath = resolve(outDir, name);
      const mtimeMs = statSync(fullPath).mtimeMs;
      return { name, fullPath, mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const removed: string[] = [];
  for (const [index, bundle] of bundles.entries()) {
    const overCount = index >= retentionCount;
    const overAge = nowMs - bundle.mtimeMs > maxAgeMs;
    if (!overCount && !overAge) continue;

    if (safeUnlink(bundle.fullPath)) removed.push(bundle.fullPath);
    const bundleEncryptedPath = encryptedCompanionPath(bundle.fullPath);
    if (existsSync(bundleEncryptedPath) && safeUnlink(bundleEncryptedPath))
      removed.push(bundleEncryptedPath);

    const manifestPath = resolve(outDir, manifestNameForBundle(bundle.name));
    if (existsSync(manifestPath) && safeUnlink(manifestPath)) removed.push(manifestPath);
    const manifestEncryptedPath = encryptedCompanionPath(manifestPath);
    if (existsSync(manifestEncryptedPath) && safeUnlink(manifestEncryptedPath))
      removed.push(manifestEncryptedPath);
  }

  return removed;
}

function readDrillSchemaVersion(drill: IncidentBundle['drill']): number | null {
  if (
    !drill.ok ||
    !drill.result ||
    typeof drill.result !== 'object' ||
    Array.isArray(drill.result)
  ) {
    return null;
  }
  const value = (drill.result as { schemaVersion?: unknown }).schemaVersion;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

function canonicalizeCognitiveReportsForDigest(reports: CognitiveReportSummary[]): string {
  return JSON.stringify(
    reports.map((report) => ({
      index: report.index,
      timestamp: report.timestamp,
      hash: report.hash,
      reportType: report.reportType,
      dataType: report.dataType,
      schemaVersion: report.schemaVersion,
      source: report.source,
      generatedAt: report.generatedAt,
      input: report.input,
      path: report.path,
    })),
  );
}

function buildCognitiveReportManifestIntegrity(
  snapshot: CognitiveReportSnapshot | undefined,
): CognitiveReportManifestIntegrity {
  if (!snapshot) {
    return {
      included: false,
      count: 0,
      digestSha256: null,
      schemaVersion: null,
      limit: null,
      journalPath: null,
    };
  }
  return {
    included: true,
    count: snapshot.reports.length,
    digestSha256: sha256Hex(canonicalizeCognitiveReportsForDigest(snapshot.reports)),
    schemaVersion: snapshot.schemaVersion,
    limit: snapshot.limit,
    journalPath: snapshot.journalPath,
  };
}

function writeManifest(options: {
  bundlePath: string;
  generatedAt: string;
  redactionEnabled: boolean;
  retentionCount: number;
  retentionDays: number;
  prunedFiles: string[];
  drill: IncidentBundle['drill'];
  manifestPath: string;
  signingKey: SigningKeySpec | null;
  encryptedBundle: EncryptedArtifactManifestDescriptor | null;
  encryptedManifestPath: string | null;
  cognitiveReports: CognitiveReportManifestIntegrity;
}): string {
  const bundleBytes = readFileSync(options.bundlePath);
  const manifestBase: IncidentBundleManifest = {
    schemaVersion: 1,
    generatedAt: options.generatedAt,
    bundle: {
      path: options.bundlePath,
      sha256: sha256Hex(bundleBytes),
      bytes: bundleBytes.byteLength,
    },
    redaction: {
      enabled: options.redactionEnabled,
      marker: REDACTED,
    },
    retention: {
      count: options.retentionCount,
      days: options.retentionDays,
      prunedFiles: options.prunedFiles.map((item) => basename(item)),
    },
    drill: {
      ok: options.drill.ok,
      schemaVersion: readDrillSchemaVersion(options.drill),
    },
    cognitiveReports: options.cognitiveReports,
  };

  if (options.encryptedBundle) {
    manifestBase.encryptedArtifacts = {
      schemaVersion: 1,
      format: 'memphis.encrypted-blob.v1',
      algorithm: 'aes-256-gcm',
      kdf: 'scrypt',
      bundle: options.encryptedBundle,
      manifest: options.encryptedManifestPath ? { path: options.encryptedManifestPath } : undefined,
    };
  }

  if (options.signingKey) {
    const privateKey = createPrivateKey(options.signingKey.privateKeyPem);
    const publicKeyPem = createPublicKey(privateKey)
      .export({ format: 'pem', type: 'spki' })
      .toString();
    const payload = JSON.stringify(manifestBase);
    const signatureBytes = signDetached(null, Buffer.from(payload, 'utf8'), privateKey);
    manifestBase.signature = {
      algorithm: 'ed25519',
      value: signatureBytes.toString('base64'),
      payloadSha256: sha256Hex(payload),
      keyFingerprint: sha256Hex(publicKeyPem),
      keyId: options.signingKey.keyId ?? undefined,
    };
  }

  mkdirSync(dirname(options.manifestPath), { recursive: true });
  writeFileSync(options.manifestPath, JSON.stringify(manifestBase, null, 2), 'utf8');
  return options.manifestPath;
}

function writeEncryptedArtifact(options: {
  plaintextPath: string;
  encryptedPath: string;
  purpose: 'incident-bundle' | 'incident-manifest';
  generatedAt: string;
  passphrase: string;
}): EncryptedArtifactManifestDescriptor {
  const plaintextBytes = readFileSync(options.plaintextPath);
  const encryptedBlob = encryptBlob({
    plaintext: plaintextBytes,
    passphrase: options.passphrase,
    purpose: options.purpose,
    generatedAt: options.generatedAt,
  });
  const serialized = JSON.stringify(encryptedBlob, null, 2);
  mkdirSync(dirname(options.encryptedPath), { recursive: true });
  writeFileSync(options.encryptedPath, serialized, 'utf8');
  const encryptedBytes = Buffer.from(serialized, 'utf8');
  return {
    path: options.encryptedPath,
    sha256: sha256Hex(encryptedBytes),
    bytes: encryptedBytes.byteLength,
  };
}

async function fetchStatus(
  url: string,
  redactSensitive: boolean,
): Promise<IncidentBundle['status']> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(3_000),
    });
    const text = await response.text();
    let payload: JsonValue = { raw: text };
    try {
      payload = JSON.parse(text) as JsonValue;
    } catch {
      payload = { raw: text };
    }
    if (redactSensitive) payload = redactJson(payload);
    return {
      ok: response.ok,
      url,
      httpStatus: response.status,
      payload,
    };
  } catch (error) {
    return {
      ok: false,
      url,
      httpStatus: null,
      error: redactSensitive
        ? maybeRedactString(error instanceof Error ? error.message : String(error))
        : error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

function runGuardDrillJson(repoRoot: string): IncidentBundle['drill'] {
  const out = spawnSync('npm', ['run', '-s', 'ops:drill-guards', '--', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
  if (out.status !== 0) {
    return {
      ok: false,
      error: out.stderr?.trim() || out.stdout?.trim() || `exit=${out.status ?? 'null'}`,
    };
  }
  try {
    return {
      ok: true,
      result: JSON.parse(out.stdout) as JsonValue,
    };
  } catch (error) {
    return {
      ok: false,
      error: `failed to parse drill JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function readAuditTail(auditPath: string, count: number, redactSensitive: boolean): JsonValue[] {
  try {
    const raw = readFileSync(auditPath, 'utf8');
    const parsed = tailLines(raw, count).map(parseJsonLine);
    return redactSensitive ? parsed.map((entry) => redactJson(entry)) : parsed;
  } catch {
    return [];
  }
}

function readCognitiveReportSummaries(
  journalPath: string,
  limit: number,
  redactSensitive: boolean,
): CognitiveReportSummary[] {
  if (!existsSync(journalPath)) return [];

  let names: string[] = [];
  try {
    names = readdirSync(journalPath)
      .filter((name) => name.endsWith('.json'))
      .sort();
  } catch {
    return [];
  }

  const summaries: CognitiveReportSummary[] = [];
  for (const name of names) {
    const filePath = resolve(journalPath, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    } catch {
      continue;
    }

    if (!parsed || typeof parsed !== 'object') continue;
    const block = parsed as {
      index?: unknown;
      timestamp?: unknown;
      hash?: unknown;
      data?: {
        type?: unknown;
        schemaVersion?: unknown;
        source?: unknown;
        report?: {
          generatedAt?: unknown;
          input?: unknown;
        };
      };
    };
    const dataType = typeof block.data?.type === 'string' ? block.data.type : null;
    if (!dataType || !(dataType in COGNITIVE_REPORT_TYPE_MAP)) continue;
    const source = typeof block.data?.source === 'string' ? block.data.source : null;
    const generatedAt =
      typeof block.data?.report?.generatedAt === 'string' ? block.data.report.generatedAt : null;
    const input = typeof block.data?.report?.input === 'string' ? block.data.report.input : null;

    summaries.push({
      index: typeof block.index === 'number' ? block.index : null,
      timestamp: typeof block.timestamp === 'string' ? block.timestamp : null,
      hash: typeof block.hash === 'string' ? block.hash : null,
      reportType: COGNITIVE_REPORT_TYPE_MAP[dataType as keyof typeof COGNITIVE_REPORT_TYPE_MAP],
      dataType,
      schemaVersion:
        typeof block.data?.schemaVersion === 'number' ? block.data.schemaVersion : null,
      source: redactSensitive && source ? maybeRedactString(source) : source,
      generatedAt,
      input: redactSensitive && input ? maybeRedactString(input) : input,
      path: filePath,
    });
  }

  return summaries.slice(-limit).reverse();
}

function buildCognitiveReportSnapshot(
  journalPath: string,
  limit: number,
  redactSensitive: boolean,
): CognitiveReportSnapshot {
  const reports = readCognitiveReportSummaries(journalPath, limit, redactSensitive);
  return {
    schemaVersion: 1,
    journalPath,
    limit,
    count: reports.length,
    reports,
  };
}

async function main(): Promise<void> {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(renderHelp());
    return;
  }
  if (hasFlag('--completion-hints')) {
    printCompletionHints();
    return;
  }

  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(moduleDir, '..');
  const profile = resolveExportProfileName();
  const profileDefaults = resolveExportProfileDefaults(profile);
  const redactSensitive = hasFlag('--no-redact') ? false : profileDefaults.redactSensitive;
  const statusUrl = parseArg('--status-url') ?? 'http://127.0.0.1:8080/v1/ops/status';
  const auditPath = resolve(
    parseArg('--audit-path') ??
      process.env.MEMPHIS_SECURITY_AUDIT_LOG_PATH ??
      'data/security-audit.jsonl',
  );
  const outPath = resolve(
    parseArg('--out') ??
      `data/incident-bundle-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  const auditLines = parseIntArg('--audit-lines', profileDefaults.auditLines);
  const retentionCount = parseIntArg(
    '--retention-count',
    profileDefaults.retentionCount,
    'MEMPHIS_INCIDENT_BUNDLE_RETENTION_COUNT',
  );
  const retentionDays = parseIntArg(
    '--retention-days',
    profileDefaults.retentionDays,
    'MEMPHIS_INCIDENT_BUNDLE_RETENTION_DAYS',
  );
  const manifestOut = parseArg('--manifest-out');
  const signingKey = resolveSigningKeySpec();
  const encryptionPassphrase = resolveEncryptionPassphraseSpec();
  const encryptedBundleOut = parseArg('--encrypted-bundle-out');
  const encryptedManifestOut = parseArg('--encrypted-manifest-out');
  const includeCognitiveSummariesEnv = parseOptionalBool(process.env[COGNITIVE_INCLUDE_ENV]);
  const includeCognitiveSummaries = hasFlag('--include-cognitive-summaries')
    ? true
    : (includeCognitiveSummariesEnv ?? profileDefaults.includeCognitiveSummaries);
  const cognitiveReportLimit = parseIntArg('--cognitive-report-limit', 10, COGNITIVE_LIMIT_ENV);
  const cognitiveJournalPath = resolve(
    parseArg('--cognitive-journal-path') ??
      process.env[COGNITIVE_JOURNAL_PATH_ENV] ??
      getChainPath('journal', process.env),
  );
  const queueMode = (process.env.MEMPHIS_QUEUE_MODE ?? 'financial').trim().toLowerCase();
  const requireEncryptedArtifactsEnv = parseOptionalBool(
    process.env.MEMPHIS_INCIDENT_REQUIRE_ENCRYPTED_ARTIFACTS,
  );
  const requireEncryptedArtifacts = hasFlag('--require-encrypted-artifacts')
    ? true
    : (requireEncryptedArtifactsEnv ?? profileDefaults.requireEncryptedArtifacts);
  const writeManifestRequested =
    manifestOut !== null ||
    signingKey !== null ||
    requireEncryptedArtifacts ||
    profileDefaults.writeManifest;
  if (requireEncryptedArtifacts && !encryptionPassphrase) {
    throw new Error(
      'encrypted artifacts are required by policy; provide --encryption-passphrase (or matching env source)',
    );
  }

  const bundle: IncidentBundle = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    status: await fetchStatus(statusUrl, redactSensitive),
    securityAudit: {
      path: auditPath,
      tailLines: readAuditTail(auditPath, auditLines, redactSensitive),
    },
    drill: runGuardDrillJson(repoRoot),
  };
  if (includeCognitiveSummaries) {
    bundle.cognitiveReports = buildCognitiveReportSnapshot(
      cognitiveJournalPath,
      cognitiveReportLimit,
      redactSensitive,
    );
  }
  const cognitiveManifestIntegrity = buildCognitiveReportManifestIntegrity(bundle.cognitiveReports);

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(bundle, null, 2), 'utf8');
  const encryptedBundlePath = encryptionPassphrase
    ? resolve(encryptedBundleOut ?? encryptedCompanionPath(outPath))
    : null;
  const encryptedBundleDescriptor =
    encryptionPassphrase && encryptedBundlePath
      ? writeEncryptedArtifact({
          plaintextPath: outPath,
          encryptedPath: encryptedBundlePath,
          purpose: 'incident-bundle',
          generatedAt: bundle.generatedAt,
          passphrase: encryptionPassphrase.passphrase,
        })
      : null;

  const prunedFiles = pruneIncidentBundleHistory(outPath, retentionCount, retentionDays);
  const expectedManifestPath = resolve(manifestOut ?? inferManifestPath(outPath));
  const encryptedManifestPath =
    encryptionPassphrase && writeManifestRequested
      ? resolve(encryptedManifestOut ?? encryptedCompanionPath(expectedManifestPath))
      : null;
  const manifestPath = writeManifestRequested
    ? writeManifest({
        bundlePath: outPath,
        generatedAt: bundle.generatedAt,
        redactionEnabled: redactSensitive,
        retentionCount,
        retentionDays,
        prunedFiles,
        drill: bundle.drill,
        manifestPath: expectedManifestPath,
        signingKey,
        encryptedBundle: encryptedBundleDescriptor,
        encryptedManifestPath,
        cognitiveReports: cognitiveManifestIntegrity,
      })
    : null;
  const encryptedManifestDescriptor =
    encryptionPassphrase && manifestPath && encryptedManifestPath
      ? writeEncryptedArtifact({
          plaintextPath: manifestPath,
          encryptedPath: encryptedManifestPath,
          purpose: 'incident-manifest',
          generatedAt: bundle.generatedAt,
          passphrase: encryptionPassphrase.passphrase,
        })
      : null;

  console.log(
    JSON.stringify(
      {
        ok: true,
        output: outPath,
        manifest: manifestPath,
        prunedFiles: prunedFiles.map((item) => basename(item)),
        signingKeySource: signingKey?.source ?? null,
        signingKeyId: signingKey?.keyId ?? null,
        policy: {
          profile,
          queueMode,
          requireEncryptedArtifacts,
          manifestRequested: writeManifestRequested,
        },
        cognitiveReports: includeCognitiveSummaries
          ? {
              enabled: true,
              journalPath: cognitiveJournalPath,
              limit: cognitiveReportLimit,
              count: bundle.cognitiveReports?.count ?? 0,
              digestSha256: cognitiveManifestIntegrity.digestSha256,
            }
          : { enabled: false, digestSha256: null },
        encryption: encryptionPassphrase
          ? {
              enabled: true,
              source: encryptionPassphrase.source,
              encryptedBundle: encryptedBundleDescriptor
                ? {
                    path: encryptedBundleDescriptor.path,
                    sha256: encryptedBundleDescriptor.sha256,
                    bytes: encryptedBundleDescriptor.bytes,
                  }
                : null,
              encryptedManifest: encryptedManifestDescriptor
                ? {
                    path: encryptedManifestDescriptor.path,
                    sha256: encryptedManifestDescriptor.sha256,
                    bytes: encryptedManifestDescriptor.bytes,
                  }
                : null,
            }
          : { enabled: false },
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
