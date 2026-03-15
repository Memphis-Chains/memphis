import { randomUUID, createPublicKey, verify as verifyDetached } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  decryptBlob,
  isEncryptedBlobJson,
  parseEncryptedBlob,
  sha256Hex,
} from './lib/encrypted-blob.mts';
import { appendBlock, type AppendBlockResult } from '../src/infra/storage/chain-adapter.js';

interface BundleDescriptor {
  path: string;
  sha256: string;
  bytes: number;
}

interface SignatureDescriptor {
  algorithm: 'ed25519';
  value: string;
  payloadSha256: string;
  keyFingerprint: string;
  keyId?: string;
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
  bundle: BundleDescriptor;
  cognitiveReports?: CognitiveReportManifestIntegrity;
  encryptedArtifacts?: {
    schemaVersion: number;
    format: string;
    algorithm: string;
    kdf: string;
    bundle: BundleDescriptor;
    manifest?: {
      path: string;
    };
  };
  signature?: SignatureDescriptor;
}

interface PublicKeyBundleEntry {
  keyId: string;
  publicKeyPem: string;
}

interface PublicKeyBundleProvenance {
  algorithm: 'ed25519';
  signerRootId: string;
  signerPublicKeyPem: string;
  payloadSha256: string;
  signature: string;
  signedAt?: string;
}

interface PublicKeyBundle {
  schemaVersion: number;
  keys: PublicKeyBundleEntry[];
  provenance?: PublicKeyBundleProvenance;
}

interface TrustRootManifest {
  version: number;
  rootIds: string[];
}

interface VerifyOutput {
  ok: boolean;
  manifestPath: string;
  bundlePath: string;
  policy: {
    profile: VerifyProfileName | null;
    requireSignature: boolean;
    requireSignedKeyBundle: boolean;
    requireCognitiveSummaries: boolean;
    skipChainEvent: boolean;
    requireChainEvent: boolean;
    chainEventRetries: number;
    chainEventBackoffMs: number;
  };
  checks: {
    schemaValid: boolean;
    manifestEncrypted: boolean;
    bundleExists: boolean;
    bundleEncrypted: boolean;
    bundleHashMatch: boolean;
    bundleSizeMatch: boolean;
    cognitiveSummaryMetadataPresent: boolean;
    cognitiveSummaryCountMatch: boolean;
    cognitiveSummaryDigestMatch: boolean;
    cognitiveSummaryRequirementSatisfied: boolean;
    signaturePresent: boolean;
    signatureVerified: boolean;
    payloadHashMatch: boolean;
    keyFingerprintMatch: boolean;
    keyIdMatch: boolean;
    keyBundleSignatureValid: boolean;
    keyBundleTrustRootMatch: boolean;
  };
  errors: string[];
  chainEvent?: {
    attempted: boolean;
    written: boolean;
    chain: 'system';
    attempts: number;
    index?: number;
    hash?: string;
    error?: string;
  };
}

type VerifyProfileName = 'trust-root-strict' | 'legacy-compat';

interface VerifyProfileDefaults {
  requireSignature: boolean;
  requireSignedKeyBundle: boolean;
  requireCognitiveSummaries: boolean;
  requireChainEvent: boolean;
  chainEventRetries: number;
  chainEventBackoffMs: number;
}

const VERIFY_PROFILE_VALUES: VerifyProfileName[] = ['trust-root-strict', 'legacy-compat'];
const VERIFY_PROFILE_ENV = 'MEMPHIS_INCIDENT_MANIFEST_VERIFY_PROFILE';
const REQUIRE_COGNITIVE_SUMMARIES_ENV = 'MEMPHIS_INCIDENT_REQUIRE_COGNITIVE_SUMMARIES';

function parseArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (typeof raw !== 'string') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

function parseIntArg(flag: string, fallback: number, envName?: string): number {
  const rawArg = parseArg(flag);
  if (rawArg) {
    const parsed = Number.parseInt(rawArg, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  const rawEnv = envName ? process.env[envName] : undefined;
  if (typeof rawEnv === 'string' && rawEnv.trim().length > 0) {
    const parsed = Number.parseInt(rawEnv, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

function parseOptionalBool(raw: string | undefined): boolean | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  return parseBool(raw, false);
}

function renderHelp(): string {
  return [
    'Usage: npm run -s ops:verify-incident-manifest -- [options]',
    '',
    'Options:',
    '  --profile <name>                Verify policy profile: trust-root-strict|legacy-compat',
    '  --require-cognitive-summaries   Fail when manifest/bundle cognitive summary metadata is missing',
    '  --completion-hints              Print machine-readable profile/completion hints as JSON',
    '  -h, --help                      Show this help message',
    '',
    'Profile env variables:',
    `  ${VERIFY_PROFILE_ENV}=trust-root-strict|legacy-compat`,
    '  MEMPHIS_INCIDENT_CHAIN_EVENT_REQUIRED=true|false',
    `  ${REQUIRE_COGNITIVE_SUMMARIES_ENV}=true|false`,
  ].join('\n');
}

function printCompletionHints(): void {
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        command: 'ops:verify-incident-manifest',
        profiles: VERIFY_PROFILE_VALUES,
        profileFlag: '--profile',
        profileEnv: VERIFY_PROFILE_ENV,
        policyEnvVars: ['MEMPHIS_INCIDENT_CHAIN_EVENT_REQUIRED', REQUIRE_COGNITIVE_SUMMARIES_ENV],
      },
      null,
      2,
    ),
  );
}

function resolveVerifyProfileName(): VerifyProfileName | null {
  const raw = parseArg('--profile') ?? process.env[VERIFY_PROFILE_ENV] ?? null;
  if (!raw) return null;
  if (raw === 'trust-root-strict' || raw === 'legacy-compat') return raw;
  throw new Error(
    `unsupported verify profile: ${raw}; expected one of trust-root-strict, legacy-compat`,
  );
}

function resolveVerifyProfileDefaults(profile: VerifyProfileName | null): VerifyProfileDefaults {
  if (profile === 'trust-root-strict') {
    return {
      requireSignature: true,
      requireSignedKeyBundle: true,
      requireCognitiveSummaries: true,
      requireChainEvent: true,
      chainEventRetries: 2,
      chainEventBackoffMs: 50,
    };
  }
  if (profile === 'legacy-compat') {
    return {
      requireSignature: false,
      requireSignedKeyBundle: false,
      requireCognitiveSummaries: false,
      requireChainEvent: false,
      chainEventRetries: 0,
      chainEventBackoffMs: 0,
    };
  }
  return {
    requireSignature: false,
    requireSignedKeyBundle: false,
    requireCognitiveSummaries: false,
    requireChainEvent: true,
    chainEventRetries: 2,
    chainEventBackoffMs: 50,
  };
}

function resolveDecryptionPassphrase(): string | null {
  const argRaw = parseArg('--decryption-passphrase');
  const argBase64 = parseArg('--decryption-passphrase-base64');
  const argFile = parseArg('--decryption-passphrase-file');

  const envRaw = process.env.MEMPHIS_INCIDENT_BUNDLE_DECRYPTION_PASSPHRASE ?? null;
  const envBase64 = process.env.MEMPHIS_INCIDENT_BUNDLE_DECRYPTION_PASSPHRASE_BASE64 ?? null;
  const envFile = process.env.MEMPHIS_INCIDENT_BUNDLE_DECRYPTION_PASSPHRASE_FILE ?? null;

  const declared = [argRaw, argBase64, argFile, envRaw, envBase64, envFile].filter(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
  if (declared.length === 0) return null;
  if (declared.length > 1) {
    throw new Error(
      'multiple decryption passphrase sources provided; use exactly one of --decryption-passphrase, --decryption-passphrase-base64, --decryption-passphrase-file (or matching env vars)',
    );
  }

  if (argBase64 || envBase64) {
    return Buffer.from(argBase64 ?? envBase64 ?? '', 'base64').toString('utf8');
  }
  if (argFile || envFile) {
    return readFileSync(resolve(argFile ?? envFile ?? ''), 'utf8').trim();
  }
  return argRaw ?? envRaw ?? null;
}

function resolveManifestPath(): string {
  const provided =
    parseArg('--manifest-path') ??
    parseArg('--manifest') ??
    process.env.MEMPHIS_INCIDENT_BUNDLE_MANIFEST_PATH;
  if (!provided) {
    throw new Error('missing required --manifest-path (or MEMPHIS_INCIDENT_BUNDLE_MANIFEST_PATH)');
  }
  return resolve(provided);
}

function parseManifestObject(parsed: unknown): IncidentBundleManifest {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('manifest must be a JSON object');
  }
  const value = parsed as { [k: string]: unknown };
  const schemaVersion = value.schemaVersion;
  const generatedAt = value.generatedAt;
  const bundle = value.bundle;
  if (schemaVersion !== 1) throw new Error('manifest schemaVersion must be 1');
  if (typeof generatedAt !== 'string' || generatedAt.length === 0) {
    throw new Error('manifest generatedAt must be a non-empty string');
  }
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error('manifest bundle must be an object');
  }
  const bundleObj = bundle as { [k: string]: unknown };
  if (typeof bundleObj.path !== 'string' || bundleObj.path.length === 0) {
    throw new Error('manifest bundle.path must be a non-empty string');
  }
  if (typeof bundleObj.sha256 !== 'string' || bundleObj.sha256.length === 0) {
    throw new Error('manifest bundle.sha256 must be a non-empty string');
  }
  if (
    typeof bundleObj.bytes !== 'number' ||
    !Number.isFinite(bundleObj.bytes) ||
    bundleObj.bytes < 0
  ) {
    throw new Error('manifest bundle.bytes must be a non-negative number');
  }

  let cognitiveReports: CognitiveReportManifestIntegrity | undefined = undefined;
  if (value.cognitiveReports !== undefined) {
    if (
      !value.cognitiveReports ||
      typeof value.cognitiveReports !== 'object' ||
      Array.isArray(value.cognitiveReports)
    ) {
      throw new Error('manifest cognitiveReports must be an object when present');
    }
    const row = value.cognitiveReports as { [k: string]: unknown };
    if (typeof row.included !== 'boolean') {
      throw new Error('manifest cognitiveReports.included must be a boolean');
    }
    if (
      typeof row.count !== 'number' ||
      !Number.isFinite(row.count) ||
      row.count < 0 ||
      !Number.isInteger(row.count)
    ) {
      throw new Error('manifest cognitiveReports.count must be a non-negative integer');
    }
    if (
      row.digestSha256 !== null &&
      (typeof row.digestSha256 !== 'string' || row.digestSha256.length === 0)
    ) {
      throw new Error('manifest cognitiveReports.digestSha256 must be a non-empty string or null');
    }
    if (
      row.schemaVersion !== null &&
      row.schemaVersion !== undefined &&
      (typeof row.schemaVersion !== 'number' || !Number.isFinite(row.schemaVersion))
    ) {
      throw new Error('manifest cognitiveReports.schemaVersion must be a finite number or null');
    }
    if (
      row.limit !== null &&
      row.limit !== undefined &&
      (typeof row.limit !== 'number' ||
        !Number.isFinite(row.limit) ||
        row.limit < 0 ||
        !Number.isInteger(row.limit))
    ) {
      throw new Error('manifest cognitiveReports.limit must be a non-negative integer or null');
    }
    if (
      row.journalPath !== null &&
      row.journalPath !== undefined &&
      (typeof row.journalPath !== 'string' || row.journalPath.length === 0)
    ) {
      throw new Error('manifest cognitiveReports.journalPath must be a non-empty string or null');
    }
    if (!row.included && row.count !== 0) {
      throw new Error('manifest cognitiveReports.count must be 0 when included=false');
    }
    if (!row.included && row.digestSha256 !== null) {
      throw new Error('manifest cognitiveReports.digestSha256 must be null when included=false');
    }
    if (row.included && typeof row.digestSha256 !== 'string') {
      throw new Error('manifest cognitiveReports.digestSha256 must be present when included=true');
    }

    cognitiveReports = {
      included: row.included,
      count: row.count,
      digestSha256: (row.digestSha256 ?? null) as string | null,
      schemaVersion: row.schemaVersion === undefined ? null : (row.schemaVersion as number | null),
      limit: row.limit === undefined ? null : (row.limit as number | null),
      journalPath: row.journalPath === undefined ? null : (row.journalPath as string | null),
    };
  }

  let encryptedArtifacts: IncidentBundleManifest['encryptedArtifacts'] | undefined = undefined;
  if (value.encryptedArtifacts !== undefined) {
    if (
      !value.encryptedArtifacts ||
      typeof value.encryptedArtifacts !== 'object' ||
      Array.isArray(value.encryptedArtifacts)
    ) {
      throw new Error('manifest encryptedArtifacts must be an object when present');
    }
    const encrypted = value.encryptedArtifacts as { [k: string]: unknown };
    if (encrypted.schemaVersion !== 1) {
      throw new Error('manifest encryptedArtifacts.schemaVersion must be 1');
    }
    if (encrypted.format !== 'memphis.encrypted-blob.v1') {
      throw new Error('manifest encryptedArtifacts.format must be memphis.encrypted-blob.v1');
    }
    if (encrypted.algorithm !== 'aes-256-gcm') {
      throw new Error('manifest encryptedArtifacts.algorithm must be aes-256-gcm');
    }
    if (encrypted.kdf !== 'scrypt') {
      throw new Error('manifest encryptedArtifacts.kdf must be scrypt');
    }
    if (
      !encrypted.bundle ||
      typeof encrypted.bundle !== 'object' ||
      Array.isArray(encrypted.bundle)
    ) {
      throw new Error('manifest encryptedArtifacts.bundle must be an object');
    }
    const encryptedBundle = encrypted.bundle as { [k: string]: unknown };
    if (typeof encryptedBundle.path !== 'string' || encryptedBundle.path.length === 0) {
      throw new Error('manifest encryptedArtifacts.bundle.path must be a non-empty string');
    }
    if (typeof encryptedBundle.sha256 !== 'string' || encryptedBundle.sha256.length === 0) {
      throw new Error('manifest encryptedArtifacts.bundle.sha256 must be a non-empty string');
    }
    if (
      typeof encryptedBundle.bytes !== 'number' ||
      !Number.isFinite(encryptedBundle.bytes) ||
      encryptedBundle.bytes < 0
    ) {
      throw new Error('manifest encryptedArtifacts.bundle.bytes must be a non-negative number');
    }
    let manifestEncryptedPath: string | undefined = undefined;
    if (encrypted.manifest !== undefined) {
      if (
        !encrypted.manifest ||
        typeof encrypted.manifest !== 'object' ||
        Array.isArray(encrypted.manifest)
      ) {
        throw new Error('manifest encryptedArtifacts.manifest must be an object when present');
      }
      const encryptedManifest = encrypted.manifest as { [k: string]: unknown };
      if (typeof encryptedManifest.path !== 'string' || encryptedManifest.path.length === 0) {
        throw new Error('manifest encryptedArtifacts.manifest.path must be a non-empty string');
      }
      manifestEncryptedPath = encryptedManifest.path;
    }
    encryptedArtifacts = {
      schemaVersion: 1,
      format: 'memphis.encrypted-blob.v1',
      algorithm: 'aes-256-gcm',
      kdf: 'scrypt',
      bundle: {
        path: encryptedBundle.path,
        sha256: encryptedBundle.sha256,
        bytes: encryptedBundle.bytes,
      },
      manifest: manifestEncryptedPath ? { path: manifestEncryptedPath } : undefined,
    };
  }

  if (value.signature === undefined) {
    return {
      schemaVersion,
      generatedAt,
      bundle: {
        path: bundleObj.path,
        sha256: bundleObj.sha256,
        bytes: bundleObj.bytes,
      },
      cognitiveReports,
      encryptedArtifacts,
    };
  }

  if (!value.signature || typeof value.signature !== 'object' || Array.isArray(value.signature)) {
    throw new Error('manifest signature must be an object when present');
  }
  const signature = value.signature as { [k: string]: unknown };
  if (signature.algorithm !== 'ed25519')
    throw new Error('manifest signature.algorithm must be ed25519');
  if (typeof signature.value !== 'string' || signature.value.length === 0) {
    throw new Error('manifest signature.value must be a non-empty string');
  }
  if (typeof signature.payloadSha256 !== 'string' || signature.payloadSha256.length === 0) {
    throw new Error('manifest signature.payloadSha256 must be a non-empty string');
  }
  if (typeof signature.keyFingerprint !== 'string' || signature.keyFingerprint.length === 0) {
    throw new Error('manifest signature.keyFingerprint must be a non-empty string');
  }
  if (
    signature.keyId !== undefined &&
    (typeof signature.keyId !== 'string' || signature.keyId.length === 0)
  ) {
    throw new Error('manifest signature.keyId must be a non-empty string when present');
  }

  return {
    schemaVersion,
    generatedAt,
    bundle: {
      path: bundleObj.path,
      sha256: bundleObj.sha256,
      bytes: bundleObj.bytes,
    },
    cognitiveReports,
    encryptedArtifacts,
    signature: {
      algorithm: 'ed25519',
      value: signature.value,
      payloadSha256: signature.payloadSha256,
      keyFingerprint: signature.keyFingerprint,
      keyId: signature.keyId as string | undefined,
    },
  };
}

function resolveBundlePath(bundlePath: string, manifestPath: string): string {
  const override = parseArg('--bundle-path') ?? process.env.MEMPHIS_INCIDENT_BUNDLE_PATH;
  if (override) return resolve(override);
  if (isAbsolute(bundlePath)) return bundlePath;
  return resolve(dirname(manifestPath), bundlePath);
}

function resolveEncryptedCompanionPath(path: string): string {
  return `${path}.enc`;
}

function loadManifest(options: {
  manifestPath: string;
  decryptionPassphrase: string | null;
  checks: VerifyOutput['checks'];
  errors: string[];
}): { manifest: IncidentBundleManifest | null; manifestObject: Record<string, unknown> } {
  try {
    const rawBytes = readFileSync(options.manifestPath);
    const parsed = JSON.parse(rawBytes.toString('utf8')) as unknown;
    if (isEncryptedBlobJson(parsed)) {
      options.checks.manifestEncrypted = true;
      if (!options.decryptionPassphrase) {
        options.errors.push(
          'manifest is encrypted; provide --decryption-passphrase or matching env var',
        );
        return { manifest: null, manifestObject: {} };
      }
      const decryptedManifest = decryptBlob({
        blob: parseEncryptedBlob(rawBytes),
        passphrase: options.decryptionPassphrase,
      });
      const manifestObject = JSON.parse(decryptedManifest.toString('utf8')) as Record<
        string,
        unknown
      >;
      const manifest = parseManifestObject(manifestObject);
      options.checks.schemaValid = true;
      return { manifest, manifestObject };
    }

    const manifestObject = parsed as Record<string, unknown>;
    const manifest = parseManifestObject(manifestObject);
    options.checks.schemaValid = true;
    return { manifest, manifestObject };
  } catch (error) {
    options.errors.push(error instanceof Error ? error.message : String(error));
    return { manifest: null, manifestObject: {} };
  }
}

function resolveBundleBytes(options: {
  manifest: IncidentBundleManifest;
  manifestPath: string;
  decryptionPassphrase: string | null;
  preferEncrypted: boolean;
  checks: VerifyOutput['checks'];
  errors: string[];
}): { bundlePath: string; bytes: Buffer | null } {
  const plainPath = resolveBundlePath(options.manifest.bundle.path, options.manifestPath);
  const encryptedPathFromManifest = options.manifest.encryptedArtifacts?.bundle?.path
    ? isAbsolute(options.manifest.encryptedArtifacts.bundle.path)
      ? options.manifest.encryptedArtifacts.bundle.path
      : resolve(dirname(options.manifestPath), options.manifest.encryptedArtifacts.bundle.path)
    : null;
  const encryptedCandidates = [
    encryptedPathFromManifest,
    resolveEncryptedCompanionPath(plainPath),
  ].filter((value): value is string => Boolean(value));
  const orderedCandidates = options.preferEncrypted
    ? [...encryptedCandidates, plainPath]
    : [plainPath, ...encryptedCandidates];

  const uniqueCandidates = [...new Set(orderedCandidates)];
  for (const candidate of uniqueCandidates) {
    if (!existsSync(candidate)) continue;

    options.checks.bundleExists = true;
    const bytes = readFileSync(candidate);
    try {
      const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
      if (isEncryptedBlobJson(parsed)) {
        options.checks.bundleEncrypted = true;
        if (!options.decryptionPassphrase) {
          options.errors.push(
            `bundle file is encrypted (${candidate}); provide --decryption-passphrase or matching env var`,
          );
          return { bundlePath: candidate, bytes: null };
        }
        const decrypted = decryptBlob({
          blob: parseEncryptedBlob(bytes),
          passphrase: options.decryptionPassphrase,
        });
        return { bundlePath: candidate, bytes: decrypted };
      }
      return { bundlePath: candidate, bytes };
    } catch {
      return { bundlePath: candidate, bytes };
    }
  }

  options.errors.push(`bundle file not found: ${plainPath}`);
  return { bundlePath: plainPath, bytes: null };
}

function normalizeStringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function normalizeNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function canonicalizeCognitiveReportsForDigest(reports: unknown[]): string {
  const normalized = reports.map((report) => {
    const row =
      report && typeof report === 'object' && !Array.isArray(report)
        ? (report as { [k: string]: unknown })
        : {};
    return {
      index: normalizeNumberOrNull(row.index),
      timestamp: normalizeStringOrNull(row.timestamp),
      hash: normalizeStringOrNull(row.hash),
      reportType: normalizeStringOrNull(row.reportType),
      dataType: normalizeStringOrNull(row.dataType),
      schemaVersion: normalizeNumberOrNull(row.schemaVersion),
      source: normalizeStringOrNull(row.source),
      generatedAt: normalizeStringOrNull(row.generatedAt),
      input: normalizeStringOrNull(row.input),
      path: normalizeStringOrNull(row.path),
    };
  });
  return JSON.stringify(normalized);
}

function verifyCognitiveSummaryIntegrity(options: {
  manifest: IncidentBundleManifest;
  bundleBytes: Buffer;
  requireCognitiveSummaries: boolean;
  checks: VerifyOutput['checks'];
  errors: string[];
}): void {
  const cognitive = options.manifest.cognitiveReports;
  options.checks.cognitiveSummaryMetadataPresent = Boolean(cognitive);
  if (!cognitive) {
    if (options.requireCognitiveSummaries) {
      options.checks.cognitiveSummaryRequirementSatisfied = false;
      options.checks.cognitiveSummaryCountMatch = false;
      options.checks.cognitiveSummaryDigestMatch = false;
      options.errors.push(
        'cognitive summaries are required but manifest.cognitiveReports is missing',
      );
    }
    return;
  }

  if (options.requireCognitiveSummaries && !cognitive.included) {
    options.checks.cognitiveSummaryRequirementSatisfied = false;
    options.errors.push(
      'cognitive summaries are required but manifest.cognitiveReports.included=false',
    );
  }

  let bundle: unknown;
  try {
    bundle = JSON.parse(options.bundleBytes.toString('utf8'));
  } catch (error) {
    options.checks.cognitiveSummaryRequirementSatisfied = false;
    options.checks.cognitiveSummaryCountMatch = false;
    options.checks.cognitiveSummaryDigestMatch = false;
    options.errors.push(
      `failed to parse bundle JSON for cognitive summary integrity checks: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  const bundleObject =
    bundle && typeof bundle === 'object' && !Array.isArray(bundle)
      ? (bundle as { [k: string]: unknown })
      : {};
  const bundleCognitive =
    bundleObject.cognitiveReports &&
    typeof bundleObject.cognitiveReports === 'object' &&
    !Array.isArray(bundleObject.cognitiveReports)
      ? (bundleObject.cognitiveReports as { [k: string]: unknown })
      : null;
  const hasReports = Array.isArray(bundleCognitive?.reports);
  const reports = hasReports ? bundleCognitive.reports : [];
  if (cognitive.included && !hasReports) {
    options.checks.cognitiveSummaryRequirementSatisfied = false;
    options.checks.cognitiveSummaryCountMatch = false;
    options.checks.cognitiveSummaryDigestMatch = false;
    options.errors.push(
      'manifest requires embedded cognitive summaries but bundle payload is missing cognitiveReports.reports',
    );
    return;
  }
  if (options.requireCognitiveSummaries && !hasReports) {
    options.checks.cognitiveSummaryRequirementSatisfied = false;
    options.checks.cognitiveSummaryCountMatch = false;
    options.checks.cognitiveSummaryDigestMatch = false;
    options.errors.push(
      'cognitive summaries are required but bundle payload is missing cognitiveReports.reports',
    );
    return;
  }

  const actualCount = reports.length;
  options.checks.cognitiveSummaryCountMatch = actualCount === cognitive.count;
  if (!options.checks.cognitiveSummaryCountMatch) {
    options.checks.cognitiveSummaryRequirementSatisfied = false;
    options.errors.push(
      `cognitive summary count mismatch (expected=${cognitive.count}, actual=${actualCount})`,
    );
  }

  const actualDigest = cognitive.included
    ? sha256Hex(canonicalizeCognitiveReportsForDigest(reports))
    : reports.length > 0
      ? sha256Hex(canonicalizeCognitiveReportsForDigest(reports))
      : null;
  options.checks.cognitiveSummaryDigestMatch = actualDigest === cognitive.digestSha256;
  if (!options.checks.cognitiveSummaryDigestMatch) {
    options.checks.cognitiveSummaryRequirementSatisfied = false;
    options.errors.push(
      `cognitive summary digest mismatch (expected=${cognitive.digestSha256 ?? 'null'}, actual=${actualDigest ?? 'null'})`,
    );
  }
}

function parsePublicKeyBundle(raw: string): PublicKeyBundle {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('public key bundle must be a JSON object');
  }
  const value = parsed as { [k: string]: unknown };
  if (value.schemaVersion !== 1) throw new Error('public key bundle schemaVersion must be 1');
  if (!Array.isArray(value.keys)) throw new Error('public key bundle keys must be an array');
  const keys: PublicKeyBundleEntry[] = [];
  for (const entry of value.keys) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('public key bundle entry must be an object');
    }
    const row = entry as { [k: string]: unknown };
    if (typeof row.keyId !== 'string' || row.keyId.length === 0) {
      throw new Error('public key bundle entry keyId must be a non-empty string');
    }
    if (typeof row.publicKeyPem !== 'string' || row.publicKeyPem.length === 0) {
      throw new Error('public key bundle entry publicKeyPem must be a non-empty string');
    }
    keys.push({ keyId: row.keyId, publicKeyPem: row.publicKeyPem });
  }

  let provenance: PublicKeyBundleProvenance | undefined = undefined;
  if (value.provenance !== undefined) {
    if (
      !value.provenance ||
      typeof value.provenance !== 'object' ||
      Array.isArray(value.provenance)
    ) {
      throw new Error('public key bundle provenance must be an object when present');
    }
    const row = value.provenance as { [k: string]: unknown };
    if (row.algorithm !== 'ed25519') {
      throw new Error('public key bundle provenance.algorithm must be ed25519');
    }
    if (typeof row.signerRootId !== 'string' || row.signerRootId.length === 0) {
      throw new Error('public key bundle provenance.signerRootId must be a non-empty string');
    }
    if (typeof row.signerPublicKeyPem !== 'string' || row.signerPublicKeyPem.length === 0) {
      throw new Error('public key bundle provenance.signerPublicKeyPem must be a non-empty string');
    }
    if (typeof row.payloadSha256 !== 'string' || row.payloadSha256.length === 0) {
      throw new Error('public key bundle provenance.payloadSha256 must be a non-empty string');
    }
    if (typeof row.signature !== 'string' || row.signature.length === 0) {
      throw new Error('public key bundle provenance.signature must be a non-empty string');
    }
    if (
      row.signedAt !== undefined &&
      (typeof row.signedAt !== 'string' || row.signedAt.length === 0)
    ) {
      throw new Error(
        'public key bundle provenance.signedAt must be a non-empty string when present',
      );
    }
    provenance = {
      algorithm: 'ed25519',
      signerRootId: row.signerRootId,
      signerPublicKeyPem: row.signerPublicKeyPem,
      payloadSha256: row.payloadSha256,
      signature: row.signature,
      signedAt: row.signedAt as string | undefined,
    };
  }

  return { schemaVersion: 1, keys, provenance };
}

function resolveTrustRootPath(): string {
  const provided =
    parseArg('--trust-root-path') ??
    process.env.MEMPHIS_TRUST_ROOT_PATH ??
    './config/trust_root.json';
  return resolve(provided);
}

function parseTrustRootManifest(raw: string): TrustRootManifest {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('trust root manifest must be a JSON object');
  }
  const value = parsed as { [k: string]: unknown };
  const version = value.version;
  const rootIdsRaw = value.rootIds;
  if (!Number.isInteger(version) || Number(version) <= 0) {
    throw new Error('trust root manifest version must be a positive integer');
  }
  if (!Array.isArray(rootIdsRaw) || rootIdsRaw.length === 0) {
    throw new Error('trust root manifest rootIds must be a non-empty array');
  }
  const rootIds = rootIdsRaw.filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  );
  if (rootIds.length !== rootIdsRaw.length) {
    throw new Error('trust root manifest rootIds entries must be non-empty strings');
  }
  return { version, rootIds };
}

function verifyKeyBundleProvenance(options: {
  bundle: PublicKeyBundle;
  requireSignedBundle: boolean;
  checks: VerifyOutput['checks'];
  errors: string[];
}): void {
  const provenance = options.bundle.provenance;
  if (!provenance) {
    if (options.requireSignedBundle) {
      options.checks.keyBundleSignatureValid = false;
      options.checks.keyBundleTrustRootMatch = false;
      options.errors.push('public key bundle signature is required but provenance is missing');
    }
    return;
  }

  try {
    const unsignedPayload = JSON.stringify({
      schemaVersion: options.bundle.schemaVersion,
      keys: options.bundle.keys,
    });
    const payloadHash = sha256Hex(unsignedPayload);
    options.checks.keyBundleSignatureValid = payloadHash === provenance.payloadSha256;
    if (!options.checks.keyBundleSignatureValid) {
      options.errors.push('public key bundle payload hash mismatch');
    }

    const signerPublicKey = createPublicKey(provenance.signerPublicKeyPem);
    const signatureBytes = Buffer.from(provenance.signature, 'base64');
    const signatureVerified = verifyDetached(
      null,
      Buffer.from(unsignedPayload, 'utf8'),
      signerPublicKey,
      signatureBytes,
    );
    if (!signatureVerified) {
      options.checks.keyBundleSignatureValid = false;
      options.errors.push('public key bundle signature verification failed');
    }

    const signerRootId = sha256Hex(provenance.signerPublicKeyPem);
    if (signerRootId !== provenance.signerRootId) {
      options.checks.keyBundleSignatureValid = false;
      options.errors.push(
        'public key bundle signerRootId does not match signerPublicKeyPem fingerprint',
      );
    }

    const trustRootPath = resolveTrustRootPath();
    if (!existsSync(trustRootPath)) {
      options.checks.keyBundleTrustRootMatch = false;
      options.errors.push(`trust root manifest not found: ${trustRootPath}`);
      return;
    }

    const trustRoot = parseTrustRootManifest(readFileSync(trustRootPath, 'utf8'));
    options.checks.keyBundleTrustRootMatch = trustRoot.rootIds.includes(provenance.signerRootId);
    if (!options.checks.keyBundleTrustRootMatch) {
      options.errors.push(
        `public key bundle signerRootId is not trusted by current trust root manifest: ${provenance.signerRootId}`,
      );
    }
  } catch (error) {
    options.checks.keyBundleSignatureValid = false;
    options.checks.keyBundleTrustRootMatch = false;
    options.errors.push(error instanceof Error ? error.message : String(error));
  }
}

function resolvePublicKeyPem(options: {
  manifest: IncidentBundleManifest;
  expectedKeyId: string | null;
  requireSignedBundle: boolean;
  checks: VerifyOutput['checks'];
}): { publicKeyPem: string | null; source: 'path' | 'bundle' | 'none'; errors: string[] } {
  const errors: string[] = [];
  const directPathRaw =
    parseArg('--public-key-path') ??
    process.env.MEMPHIS_INCIDENT_BUNDLE_VERIFY_PUBLIC_KEY_PATH ??
    null;
  if (directPathRaw) {
    if (options.requireSignedBundle) {
      options.checks.keyBundleSignatureValid = false;
      options.checks.keyBundleTrustRootMatch = false;
      errors.push(
        'require-key-bundle-signature requires --public-key-bundle-path (direct key path is unsupported)',
      );
      return { publicKeyPem: null, source: 'none', errors };
    }
    const directPath = resolve(directPathRaw);
    if (!existsSync(directPath)) {
      errors.push(`public key file not found: ${directPath}`);
      return { publicKeyPem: null, source: 'none', errors };
    }
    return {
      publicKeyPem: readFileSync(directPath, 'utf8'),
      source: 'path',
      errors,
    };
  }

  const bundlePathRaw =
    parseArg('--public-key-bundle-path') ??
    process.env.MEMPHIS_INCIDENT_BUNDLE_PUBLIC_KEY_BUNDLE_PATH ??
    null;
  if (!bundlePathRaw) {
    if (options.requireSignedBundle) {
      options.checks.keyBundleSignatureValid = false;
      options.checks.keyBundleTrustRootMatch = false;
      errors.push(
        'public key bundle signature is required but --public-key-bundle-path is missing',
      );
    }
    return { publicKeyPem: null, source: 'none', errors };
  }

  const keyId = options.manifest.signature?.keyId ?? options.expectedKeyId;
  if (!keyId) {
    errors.push('public key bundle lookup requires signature.keyId or --expected-key-id');
    return { publicKeyPem: null, source: 'none', errors };
  }

  const bundlePath = resolve(bundlePathRaw);
  if (!existsSync(bundlePath)) {
    errors.push(`public key bundle not found: ${bundlePath}`);
    return { publicKeyPem: null, source: 'none', errors };
  }

  try {
    const bundle = parsePublicKeyBundle(readFileSync(bundlePath, 'utf8'));
    verifyKeyBundleProvenance({
      bundle,
      requireSignedBundle: options.requireSignedBundle,
      checks: options.checks,
      errors,
    });
    const key = bundle.keys.find((entry) => entry.keyId === keyId);
    if (!key) {
      errors.push(`public key bundle missing keyId: ${keyId}`);
      return { publicKeyPem: null, source: 'none', errors };
    }
    return { publicKeyPem: key.publicKeyPem, source: 'bundle', errors };
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
    return { publicKeyPem: null, source: 'none', errors };
  }
}

function verifySignature(options: {
  manifest: IncidentBundleManifest;
  manifestObject: Record<string, unknown>;
  publicKeyPem: string | null;
  expectedKeyId: string | null;
  requireSignature: boolean;
  checks: VerifyOutput['checks'];
  errors: string[];
}): void {
  const signature = options.manifest.signature;
  options.checks.signaturePresent = Boolean(signature);

  if (!signature) {
    if (options.expectedKeyId) {
      options.checks.keyIdMatch = false;
      options.errors.push('expected key id provided but manifest is unsigned');
    }
    if (options.requireSignature)
      options.errors.push('signature is required but manifest is unsigned');
    return;
  }

  if (options.expectedKeyId) {
    options.checks.keyIdMatch = signature.keyId === options.expectedKeyId;
    if (!options.checks.keyIdMatch) {
      options.errors.push(
        `signature key id mismatch (expected=${options.expectedKeyId}, actual=${signature.keyId ?? 'none'})`,
      );
    }
  }

  const unsigned = { ...options.manifestObject };
  delete unsigned.signature;
  const payload = JSON.stringify(unsigned);
  const payloadHash = sha256Hex(payload);
  options.checks.payloadHashMatch = payloadHash === signature.payloadSha256;
  if (!options.checks.payloadHashMatch) {
    options.errors.push('signature payload hash mismatch');
  }

  if (!options.publicKeyPem) {
    options.errors.push('signature is present but no public key source is available');
    return;
  }

  try {
    const publicKey = createPublicKey(options.publicKeyPem);
    const expectedFingerprint = sha256Hex(options.publicKeyPem);
    options.checks.keyFingerprintMatch = expectedFingerprint === signature.keyFingerprint;
    if (!options.checks.keyFingerprintMatch) {
      options.errors.push('signature key fingerprint mismatch');
    }

    const signatureBytes = Buffer.from(signature.value, 'base64');
    options.checks.signatureVerified = verifyDetached(
      null,
      Buffer.from(payload, 'utf8'),
      publicKey,
      signatureBytes,
    );
    if (!options.checks.signatureVerified) {
      options.errors.push('signature verification failed');
    }
  } catch (error) {
    options.errors.push(error instanceof Error ? error.message : String(error));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeVerificationChainEvent(options: {
  manifestPath: string;
  bundlePath: string;
  expectedKeyId: string | null;
  checks: VerifyOutput['checks'];
  errors: string[];
  ok: boolean;
  retries: number;
  backoffMs: number;
}): Promise<VerifyOutput['chainEvent']> {
  const eventId = randomUUID();
  const taskId = `incident-manifest-verify:${sha256Hex(options.manifestPath).slice(0, 16)}`;
  const payload = {
    type: 'system_event',
    event: 'incident_manifest.verification',
    schemaVersion: 1,
    eventId,
    timestamp: new Date().toISOString(),
    correlation: {
      taskId,
      runId: eventId,
      agentId: 'ops.verify-incident-manifest',
      toolCallId: null,
    },
    payload: {
      manifestPath: options.manifestPath,
      bundlePath: options.bundlePath,
      expectedKeyId: options.expectedKeyId,
      ok: options.ok,
      checks: options.checks,
      errors: options.errors,
    },
  } as const;

  let lastError = 'unknown_error';
  const maxAttempts = options.retries + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const appended: AppendBlockResult = await appendBlock('system', payload, process.env);
      return {
        attempted: true,
        written: true,
        chain: 'system',
        attempts: attempt,
        index: appended.index,
        hash: appended.hash,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt < maxAttempts && options.backoffMs > 0) {
        await sleep(options.backoffMs * attempt);
      }
    }
  }

  return {
    attempted: true,
    written: false,
    chain: 'system',
    attempts: maxAttempts,
    error: lastError,
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

  const manifestPath = resolveManifestPath();
  const profile = resolveVerifyProfileName();
  const profileDefaults = resolveVerifyProfileDefaults(profile);
  const requireSignature = hasFlag('--require-signature') || profileDefaults.requireSignature;
  const requireSignedKeyBundle =
    hasFlag('--require-key-bundle-signature') || profileDefaults.requireSignedKeyBundle;
  const requireCognitiveSummaries = hasFlag('--require-cognitive-summaries')
    ? true
    : (parseOptionalBool(process.env[REQUIRE_COGNITIVE_SUMMARIES_ENV]) ??
      profileDefaults.requireCognitiveSummaries);
  const decryptionPassphrase = resolveDecryptionPassphrase();
  const skipChainEvent = hasFlag('--skip-chain-event');
  const requireChainEvent =
    parseOptionalBool(process.env.MEMPHIS_INCIDENT_CHAIN_EVENT_REQUIRED) ??
    profileDefaults.requireChainEvent;
  const chainEventRetries = parseIntArg(
    '--chain-event-retry-count',
    profileDefaults.chainEventRetries,
    'MEMPHIS_INCIDENT_CHAIN_EVENT_RETRY_COUNT',
  );
  const chainEventBackoffMs = parseIntArg(
    '--chain-event-retry-backoff-ms',
    profileDefaults.chainEventBackoffMs,
    'MEMPHIS_INCIDENT_CHAIN_EVENT_RETRY_BACKOFF_MS',
  );
  const expectedKeyId =
    parseArg('--expected-key-id') ?? process.env.MEMPHIS_INCIDENT_BUNDLE_EXPECTED_KEY_ID ?? null;
  const checks: VerifyOutput['checks'] = {
    schemaValid: false,
    manifestEncrypted: false,
    bundleExists: false,
    bundleEncrypted: false,
    bundleHashMatch: false,
    bundleSizeMatch: false,
    cognitiveSummaryMetadataPresent: false,
    cognitiveSummaryCountMatch: true,
    cognitiveSummaryDigestMatch: true,
    cognitiveSummaryRequirementSatisfied: true,
    signaturePresent: false,
    signatureVerified: false,
    payloadHashMatch: false,
    keyFingerprintMatch: false,
    keyIdMatch: true,
    keyBundleSignatureValid: true,
    keyBundleTrustRootMatch: true,
  };
  const errors: string[] = [];

  let manifestObject: Record<string, unknown> = {};
  const loaded = loadManifest({
    manifestPath,
    decryptionPassphrase,
    checks,
    errors,
  });
  manifestObject = loaded.manifestObject;
  const manifest = loaded.manifest;

  let bundlePath = '';
  if (manifest) {
    const bundleResolution = resolveBundleBytes({
      manifest,
      manifestPath,
      decryptionPassphrase,
      preferEncrypted: checks.manifestEncrypted,
      checks,
      errors,
    });
    bundlePath = bundleResolution.bundlePath;
    if (bundleResolution.bytes) {
      checks.bundleHashMatch = sha256Hex(bundleResolution.bytes) === manifest.bundle.sha256;
      checks.bundleSizeMatch = bundleResolution.bytes.byteLength === manifest.bundle.bytes;
      if (!checks.bundleHashMatch) errors.push('bundle sha256 mismatch');
      if (!checks.bundleSizeMatch) errors.push('bundle byte size mismatch');
      verifyCognitiveSummaryIntegrity({
        manifest,
        bundleBytes: bundleResolution.bytes,
        requireCognitiveSummaries,
        checks,
        errors,
      });
    }

    const keyResolution = resolvePublicKeyPem({
      manifest,
      expectedKeyId,
      requireSignedBundle: requireSignedKeyBundle,
      checks,
    });
    errors.push(...keyResolution.errors);

    verifySignature({
      manifest,
      manifestObject,
      publicKeyPem: keyResolution.publicKeyPem,
      expectedKeyId,
      requireSignature,
      checks,
      errors,
    });
  }

  const verificationOk = errors.length === 0;
  const chainEvent = skipChainEvent
    ? {
        attempted: false,
        written: false,
        chain: 'system' as const,
        attempts: 0,
      }
    : await writeVerificationChainEvent({
        manifestPath,
        bundlePath,
        expectedKeyId,
        checks,
        errors,
        ok: verificationOk,
        retries: chainEventRetries,
        backoffMs: chainEventBackoffMs,
      });
  if (!skipChainEvent && chainEvent && !chainEvent.written && requireChainEvent) {
    errors.push(
      `failed to append incident verification chain event: ${chainEvent.error ?? 'unknown_error'}`,
    );
  }

  const result: VerifyOutput = {
    ok: errors.length === 0,
    manifestPath,
    bundlePath,
    policy: {
      profile,
      requireSignature,
      requireSignedKeyBundle,
      requireCognitiveSummaries,
      skipChainEvent,
      requireChainEvent,
      chainEventRetries,
      chainEventBackoffMs,
    },
    checks,
    errors,
    chainEvent,
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

try {
  await main();
} catch (error) {
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
}
