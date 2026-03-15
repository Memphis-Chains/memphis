import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

export interface EncryptedBlobV1 {
  schemaVersion: 1;
  format: 'memphis.encrypted-blob.v1';
  purpose: string;
  generatedAt: string;
  algorithm: 'aes-256-gcm';
  kdf: {
    name: 'scrypt';
    salt: string;
    N: number;
    r: number;
    p: number;
    keyLength: number;
  };
  iv: string;
  authTag: string;
  ciphertext: string;
  plaintextSha256: string;
  plaintextBytes: number;
}

interface EncryptBlobOptions {
  plaintext: Buffer;
  passphrase: string;
  purpose: string;
  generatedAt: string;
}

interface DecryptBlobOptions {
  blob: EncryptedBlobV1;
  passphrase: string;
}

const SCHEMA_VERSION = 1;
const FORMAT = 'memphis.encrypted-blob.v1';
const ALGORITHM = 'aes-256-gcm';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * 1024 * 1024,
  });
}

export function encryptBlob(options: EncryptBlobOptions): EncryptedBlobV1 {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(options.passphrase, salt);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(options.plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    schemaVersion: SCHEMA_VERSION,
    format: FORMAT,
    purpose: options.purpose,
    generatedAt: options.generatedAt,
    algorithm: ALGORITHM,
    kdf: {
      name: 'scrypt',
      salt: salt.toString('base64'),
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      keyLength: KEY_LENGTH,
    },
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    plaintextSha256: sha256Hex(options.plaintext),
    plaintextBytes: options.plaintext.byteLength,
  };
}

function assertValidEncryptedBlob(value: unknown): asserts value is EncryptedBlobV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('encrypted blob must be a JSON object');
  }
  const blob = value as Record<string, unknown>;
  if (blob.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`encrypted blob schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (blob.format !== FORMAT) {
    throw new Error(`encrypted blob format must be ${FORMAT}`);
  }
  if (blob.algorithm !== ALGORITHM) {
    throw new Error(`encrypted blob algorithm must be ${ALGORITHM}`);
  }
  if (typeof blob.purpose !== 'string' || blob.purpose.length === 0) {
    throw new Error('encrypted blob purpose must be a non-empty string');
  }
  if (typeof blob.generatedAt !== 'string' || blob.generatedAt.length === 0) {
    throw new Error('encrypted blob generatedAt must be a non-empty string');
  }
  if (!blob.kdf || typeof blob.kdf !== 'object' || Array.isArray(blob.kdf)) {
    throw new Error('encrypted blob kdf must be an object');
  }
  const kdf = blob.kdf as Record<string, unknown>;
  if (kdf.name !== 'scrypt') throw new Error('encrypted blob kdf.name must be scrypt');

  const kdfFields: Array<keyof typeof kdf> = ['salt', 'N', 'r', 'p', 'keyLength'];
  for (const field of kdfFields) {
    if (kdf[field] === undefined || kdf[field] === null) {
      throw new Error(`encrypted blob kdf.${field} is required`);
    }
  }
  if (typeof blob.iv !== 'string' || blob.iv.length === 0)
    throw new Error('encrypted blob iv is required');
  if (typeof blob.authTag !== 'string' || blob.authTag.length === 0) {
    throw new Error('encrypted blob authTag is required');
  }
  if (typeof blob.ciphertext !== 'string' || blob.ciphertext.length === 0) {
    throw new Error('encrypted blob ciphertext is required');
  }
  if (typeof blob.plaintextSha256 !== 'string' || blob.plaintextSha256.length === 0) {
    throw new Error('encrypted blob plaintextSha256 is required');
  }
  if (
    typeof blob.plaintextBytes !== 'number' ||
    !Number.isFinite(blob.plaintextBytes) ||
    blob.plaintextBytes < 0
  ) {
    throw new Error('encrypted blob plaintextBytes must be a non-negative number');
  }
}

export function parseEncryptedBlob(raw: string | Buffer): EncryptedBlobV1 {
  const parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw) as unknown;
  assertValidEncryptedBlob(parsed);
  return parsed;
}

export function isEncryptedBlobJson(value: unknown): value is EncryptedBlobV1 {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).format === FORMAT &&
    (value as Record<string, unknown>).schemaVersion === SCHEMA_VERSION,
  );
}

export function decryptBlob(options: DecryptBlobOptions): Buffer {
  const blob = options.blob;
  const salt = Buffer.from(blob.kdf.salt, 'base64');
  const iv = Buffer.from(blob.iv, 'base64');
  const authTag = Buffer.from(blob.authTag, 'base64');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');
  const key = deriveKey(options.passphrase, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  const computedSha = sha256Hex(plaintext);
  const expectedSha = Buffer.from(blob.plaintextSha256, 'utf8');
  const actualSha = Buffer.from(computedSha, 'utf8');
  if (expectedSha.byteLength !== actualSha.byteLength || !timingSafeEqual(expectedSha, actualSha)) {
    throw new Error('encrypted blob plaintext hash mismatch');
  }
  if (plaintext.byteLength !== blob.plaintextBytes) {
    throw new Error(
      `encrypted blob plaintext size mismatch (expected=${blob.plaintextBytes}, actual=${plaintext.byteLength})`,
    );
  }
  return plaintext;
}
