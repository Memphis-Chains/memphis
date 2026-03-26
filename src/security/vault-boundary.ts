import { createHash } from 'node:crypto';

import { writeSecurityAudit } from '../infra/logging/security-audit.js';
import {
  type VaultInitInput,
  type VaultEntry,
  vaultDecrypt,
  vaultEncrypt,
  vaultInit,
} from '../infra/storage/rust-vault-adapter.js';
import {
  getLatestVaultEntry,
  listVaultEntries,
  saveVaultEntry,
  verifyVaultEntry,
  type StoredVaultEntry,
} from '../infra/storage/vault-entry-store.js';

export type VaultOperationClass =
  | 'metadata-read'
  | 'secret-read'
  | 'secret-write'
  | 'bounded-use'
  | 'vault-init'
  | 'vault-recovery';

export type VaultSurface = 'cli' | 'http' | 'mcp' | 'system' | 'tui';

export type VaultAuditContext = {
  surface: VaultSurface;
  route?: string;
  command?: string;
  ip?: string;
};

export type VaultEntryMetadata = {
  key: string;
  createdAt: string;
  fingerprint: string;
  integrityOk: boolean;
  id?: string;
};

export type VaultSecretReadResult = {
  found: boolean;
  key: string;
  plaintext?: string;
  createdAt?: string;
  error?: string;
};

export function auditVaultOperation(
  ctx: VaultAuditContext,
  operation: VaultOperationClass,
  status: 'allowed' | 'blocked' | 'error',
  details: Record<string, unknown>,
): void {
  writeVaultAudit(ctx, operation, status, details);
}

function writeVaultAudit(
  ctx: VaultAuditContext,
  operation: VaultOperationClass,
  status: 'allowed' | 'blocked' | 'error',
  details: Record<string, unknown>,
): void {
  const safeDetails = Object.fromEntries(
    Object.entries(details).filter(
      ([key]) => !['plaintext', 'value', 'secret', 'ciphertext'].includes(key),
    ),
  );
  writeSecurityAudit({
    action: `vault.${operation}`,
    status,
    ip: ctx.ip,
    route: ctx.route,
    details: {
      surface: ctx.surface,
      command: ctx.command,
      ...safeDetails,
    },
  });
}

function fingerprintHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function toVaultEntryMetadata(entry: StoredVaultEntry): VaultEntryMetadata {
  return {
    key: entry.key,
    createdAt: entry.createdAt,
    fingerprint: entry.fingerprint,
    integrityOk: verifyVaultEntry(entry),
    id: entry.id,
  };
}

export function listVaultEntryMetadata(
  ctx: VaultAuditContext,
  rawEnv: NodeJS.ProcessEnv = process.env,
  key?: string,
  options: { latestPerKey?: boolean } = {},
): VaultEntryMetadata[] {
  const entries = listVaultEntries(rawEnv, key);
  const selected = options.latestPerKey
    ? [...entries].reduce<Map<string, StoredVaultEntry>>((acc, entry) => {
        acc.set(entry.key, entry);
        return acc;
      }, new Map<string, StoredVaultEntry>())
    : null;
  const result = (selected ? [...selected.values()] : entries).map(toVaultEntryMetadata);
  writeVaultAudit(ctx, 'metadata-read', 'allowed', {
    key: key ?? null,
    latestPerKey: options.latestPerKey ?? false,
    count: result.length,
  });
  return result;
}

export function readVaultSecretByKey(
  key: string,
  ctx: VaultAuditContext,
  rawEnv: NodeJS.ProcessEnv = process.env,
): VaultSecretReadResult {
  const entry = getLatestVaultEntry(key, rawEnv);
  if (!entry) {
    writeVaultAudit(ctx, 'secret-read', 'allowed', { key, found: false });
    return { found: false, key };
  }

  if (!verifyVaultEntry(entry)) {
    writeVaultAudit(ctx, 'secret-read', 'blocked', {
      key,
      found: true,
      reason: 'fingerprint_verification_failed',
      entryId: entry.id,
    });
    return {
      found: true,
      key,
      createdAt: entry.createdAt,
      error: 'Vault entry integrity verification failed',
    };
  }

  try {
    const plaintext = vaultDecrypt(entry, rawEnv);
    writeVaultAudit(ctx, 'secret-read', 'allowed', {
      key,
      found: true,
      entryId: entry.id,
      fingerprint: entry.fingerprint,
      plaintextHash: fingerprintHash(plaintext),
    });
    return {
      found: true,
      key,
      plaintext,
      createdAt: entry.createdAt,
    };
  } catch {
    writeVaultAudit(ctx, 'secret-read', 'error', {
      key,
      found: true,
      entryId: entry.id,
      reason: 'vault_decrypt_failed',
    });
    return {
      found: true,
      key,
      createdAt: entry.createdAt,
      error: 'Vault entry decryption failed',
    };
  }
}

export function initializeVault(
  input: VaultInitInput,
  ctx: VaultAuditContext,
  rawEnv: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof vaultInit> {
  const existingEntries = listVaultEntries(rawEnv);
  if (existingEntries.length > 0) {
    writeVaultAudit(ctx, 'vault-init', 'blocked', {
      reason: 'vault_reinit_blocked',
      existingEntries: existingEntries.length,
    });
    throw new Error(
      'Vault has existing entries. Re-initialization is not supported while secrets exist.',
    );
  }

  try {
    const out = vaultInit(input, rawEnv);
    writeVaultAudit(ctx, 'vault-init', 'allowed', {
      did: out.did,
      version: out.version,
    });
    return out;
  } catch {
    writeVaultAudit(ctx, 'vault-init', 'error', {
      reason: 'vault_init_failed',
    });
    throw new Error('Vault initialization failed');
  }
}

export function storeVaultSecret(
  key: string,
  plaintext: string,
  ctx: VaultAuditContext,
  rawEnv: NodeJS.ProcessEnv = process.env,
): StoredVaultEntry {
  try {
    const encrypted = vaultEncrypt(key, plaintext, rawEnv);
    const stored = saveVaultEntry(encrypted, rawEnv);
    writeVaultAudit(ctx, 'secret-write', 'allowed', {
      key,
      entryId: stored.id,
      fingerprint: stored.fingerprint,
      plaintextHash: fingerprintHash(plaintext),
    });
    return stored;
  } catch {
    writeVaultAudit(ctx, 'secret-write', 'error', {
      key,
      reason: 'vault_secret_write_failed',
    });
    throw new Error('Vault secret write failed');
  }
}

export function decryptVaultEntryValue(
  entry: VaultEntry,
  ctx: VaultAuditContext,
  rawEnv: NodeJS.ProcessEnv = process.env,
): { ok: true; plaintext: string } | { ok: false; error: string } {
  try {
    const plaintext = vaultDecrypt(entry, rawEnv);
    writeVaultAudit(ctx, 'secret-read', 'allowed', {
      key: entry.key,
      entryId: entry.id,
      plaintextHash: fingerprintHash(plaintext),
      source: 'raw-entry',
    });
    return { ok: true, plaintext };
  } catch {
    writeVaultAudit(ctx, 'secret-read', 'error', {
      key: entry.key,
      entryId: entry.id,
      source: 'raw-entry',
      reason: 'vault_decrypt_failed',
    });
    return { ok: false, error: 'Vault entry decryption failed' };
  }
}
