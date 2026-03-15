import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signDetached,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { sha256Hex } from './lib/encrypted-blob.mts';

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
  signedAt: string;
}

interface PublicKeyBundle {
  schemaVersion: 1;
  keys: PublicKeyBundleEntry[];
  provenance?: PublicKeyBundleProvenance;
}

interface TrustRootManifest {
  version: number;
  rootIds: string[];
}

interface TrustRootSigningKeySpec {
  source: 'path' | 'pem' | 'pem-base64';
  privateKeyPem: string;
}

function parseArg(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return null;
  const value = process.argv[idx + 1];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function resolveTrustRootPath(): string {
  const provided =
    parseArg('--trust-root-path') ??
    process.env.MEMPHIS_TRUST_ROOT_PATH ??
    './config/trust_root.json';
  return resolve(provided);
}

function resolveTrustRootSigningKeySpec(): TrustRootSigningKeySpec {
  const pathRaw =
    parseArg('--trust-root-signing-key-path') ??
    process.env.MEMPHIS_TRUST_ROOT_SIGNING_KEY_PATH ??
    null;
  const pemRaw =
    parseArg('--trust-root-signing-key-pem') ??
    process.env.MEMPHIS_TRUST_ROOT_SIGNING_KEY_PEM ??
    null;
  const pemBase64Raw =
    parseArg('--trust-root-signing-key-pem-base64') ??
    process.env.MEMPHIS_TRUST_ROOT_SIGNING_KEY_PEM_BASE64 ??
    null;

  const presentSources = [Boolean(pathRaw), Boolean(pemRaw), Boolean(pemBase64Raw)].filter(
    Boolean,
  ).length;
  if (presentSources === 0) {
    throw new Error(
      'missing trust root signing key source; use --trust-root-signing-key-path, --trust-root-signing-key-pem, or --trust-root-signing-key-pem-base64',
    );
  }
  if (presentSources > 1) {
    throw new Error(
      'multiple trust root signing key sources provided; use exactly one of --trust-root-signing-key-path, --trust-root-signing-key-pem, --trust-root-signing-key-pem-base64',
    );
  }

  if (pathRaw) {
    return {
      source: 'path',
      privateKeyPem: readFileSync(resolve(pathRaw), 'utf8'),
    };
  }
  if (pemRaw) {
    return {
      source: 'pem',
      privateKeyPem: pemRaw,
    };
  }
  return {
    source: 'pem-base64',
    privateKeyPem: Buffer.from(pemBase64Raw ?? '', 'base64').toString('utf8'),
  };
}

function parseTrustRootManifest(raw: string): TrustRootManifest {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('trust root manifest must be a JSON object');
  }
  const value = parsed as { [k: string]: unknown };
  if (!Number.isInteger(value.version) || Number(value.version) <= 0) {
    throw new Error('trust root manifest version must be a positive integer');
  }
  if (!Array.isArray(value.rootIds) || value.rootIds.length === 0) {
    throw new Error('trust root manifest rootIds must be a non-empty array');
  }

  const rootIds = value.rootIds.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
  if (rootIds.length !== value.rootIds.length) {
    throw new Error('trust root manifest rootIds entries must be non-empty strings');
  }
  if (new Set(rootIds).size !== rootIds.length) {
    throw new Error('trust root manifest rootIds must be unique');
  }

  return {
    version: Number(value.version),
    rootIds,
  };
}

function parsePublicKeyBundle(raw: string): PublicKeyBundle {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('public key bundle must be a JSON object');
  }
  const value = parsed as { [k: string]: unknown };
  if (value.schemaVersion !== 1) {
    throw new Error('public key bundle schemaVersion must be 1');
  }
  if (!Array.isArray(value.keys)) {
    throw new Error('public key bundle keys must be an array');
  }

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
  if (new Set(keys.map((entry) => entry.keyId)).size !== keys.length) {
    throw new Error('public key bundle contains duplicate keyId entries');
  }

  return {
    schemaVersion: 1,
    keys,
  };
}

function resolveBundleOutPath(): string {
  const provided =
    parseArg('--bundle-out') ??
    parseArg('--public-key-bundle-out') ??
    process.env.MEMPHIS_INCIDENT_PUBLIC_KEY_BUNDLE_OUT ??
    'data/public-key-bundle.json';
  return resolve(provided);
}

function resolveBaseBundlePath(bundleOutPath: string): string | null {
  const provided =
    parseArg('--base-bundle-path') ??
    parseArg('--public-key-bundle-path') ??
    process.env.MEMPHIS_INCIDENT_PUBLIC_KEY_BUNDLE_PATH ??
    null;
  if (provided) return resolve(provided);
  return existsSync(bundleOutPath) ? bundleOutPath : null;
}

function sanitizeKeyId(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]/g, '-');
}

function defaultKeyId(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `incident-key-${ts}`;
}

function resolveNewKeyId(existingKeys: PublicKeyBundleEntry[]): string {
  const provided =
    parseArg('--new-key-id') ??
    parseArg('--key-id') ??
    process.env.MEMPHIS_INCIDENT_ROTATE_NEW_KEY_ID ??
    defaultKeyId();
  if (!provided.trim()) throw new Error('new key id must be a non-empty string');
  const normalized = provided.trim();
  if (existingKeys.some((entry) => entry.keyId === normalized)) {
    throw new Error(`new key id already exists in bundle: ${normalized}`);
  }
  return normalized;
}

function resolveNewPrivateKeyOutPath(bundleOutPath: string, keyId: string): string {
  const provided =
    parseArg('--new-private-key-out') ??
    process.env.MEMPHIS_INCIDENT_ROTATE_PRIVATE_KEY_OUT ??
    null;
  if (provided) return resolve(provided);
  const safeKeyId = sanitizeKeyId(keyId);
  return resolve(dirname(bundleOutPath), `incident-signing-${safeKeyId}.pem`);
}

function resolveNewPublicKeyOutPath(bundleOutPath: string, keyId: string): string {
  const provided =
    parseArg('--new-public-key-out') ?? process.env.MEMPHIS_INCIDENT_ROTATE_PUBLIC_KEY_OUT ?? null;
  if (provided) return resolve(provided);
  const safeKeyId = sanitizeKeyId(keyId);
  return resolve(dirname(bundleOutPath), `incident-signing-${safeKeyId}.pub.pem`);
}

function loadExistingKeys(baseBundlePath: string | null): PublicKeyBundleEntry[] {
  if (!baseBundlePath) return [];
  if (!existsSync(baseBundlePath)) {
    throw new Error(`base bundle not found: ${baseBundlePath}`);
  }
  const parsed = parsePublicKeyBundle(readFileSync(baseBundlePath, 'utf8'));
  return parsed.keys;
}

function run(): void {
  const bundleOutPath = resolveBundleOutPath();
  const baseBundlePath = resolveBaseBundlePath(bundleOutPath);
  const trustRootPath = resolveTrustRootPath();
  if (!existsSync(trustRootPath)) {
    throw new Error(`trust root manifest not found: ${trustRootPath}`);
  }

  const trustRoot = parseTrustRootManifest(readFileSync(trustRootPath, 'utf8'));
  const trustRootSigner = resolveTrustRootSigningKeySpec();
  const signerPrivateKey = createPrivateKey(trustRootSigner.privateKeyPem);
  const signerPublicKeyPem = createPublicKey(signerPrivateKey)
    .export({ format: 'pem', type: 'spki' })
    .toString();
  const signerRootId = sha256Hex(signerPublicKeyPem);
  if (!trustRoot.rootIds.includes(signerRootId)) {
    throw new Error(`trust root signer is not in active trust root set: ${signerRootId}`);
  }

  const existingKeys = loadExistingKeys(baseBundlePath);
  const keyId = resolveNewKeyId(existingKeys);
  const privateKeyOutPath = resolveNewPrivateKeyOutPath(bundleOutPath, keyId);
  const publicKeyOutPath = resolveNewPublicKeyOutPath(bundleOutPath, keyId);

  const rotatedKeyPair = generateKeyPairSync('ed25519');
  const newPublicKeyPem = rotatedKeyPair.publicKey
    .export({ format: 'pem', type: 'spki' })
    .toString();
  const newPrivateKeyPem = rotatedKeyPair.privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();

  const nextKeys = [...existingKeys, { keyId, publicKeyPem: newPublicKeyPem }];
  const unsignedBundle = {
    schemaVersion: 1 as const,
    keys: nextKeys,
  };
  const unsignedPayload = JSON.stringify(unsignedBundle);

  const provenance: PublicKeyBundleProvenance = {
    algorithm: 'ed25519',
    signerRootId,
    signerPublicKeyPem,
    payloadSha256: sha256Hex(unsignedPayload),
    signature: signDetached(null, Buffer.from(unsignedPayload, 'utf8'), signerPrivateKey).toString(
      'base64',
    ),
    signedAt: new Date().toISOString(),
  };

  const outputBundle: PublicKeyBundle = {
    ...unsignedBundle,
    provenance,
  };

  mkdirSync(dirname(bundleOutPath), { recursive: true });
  mkdirSync(dirname(privateKeyOutPath), { recursive: true });
  mkdirSync(dirname(publicKeyOutPath), { recursive: true });

  writeFileSync(bundleOutPath, JSON.stringify(outputBundle, null, 2) + '\n', 'utf8');
  writeFileSync(privateKeyOutPath, newPrivateKeyPem, { encoding: 'utf8', mode: 0o600 });
  writeFileSync(publicKeyOutPath, newPublicKeyPem, 'utf8');

  const response = {
    ok: true,
    bundlePath: bundleOutPath,
    baseBundlePath,
    trustRootPath,
    trustRootVersion: trustRoot.version,
    signerRootId,
    signerKeySource: trustRootSigner.source,
    keyId,
    keyCount: outputBundle.keys.length,
    newPrivateKeyPath: privateKeyOutPath,
    newPublicKeyPath: publicKeyOutPath,
    generatedAt: provenance.signedAt,
  };
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
}

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  process.exitCode = 1;
}
