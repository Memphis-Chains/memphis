import { isIP } from 'node:net';

import { parseBool } from '../core/env.js';
import { AppError } from '../core/errors.js';
import { writeSecurityAudit } from '../infra/logging/security-audit.js';
import {
  type VaultInitInput,
  type VaultEntry,
  vaultDecrypt,
  vaultEncrypt,
  vaultInit,
  VaultAlreadyInitializedError,
  VaultEntryError,
  VaultStateError,
} from '../infra/storage/rust-vault-adapter.js';
import {
  listVaultEntries,
  readLatestVaultSecret,
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
  errorCode?: string;
};

type VaultSecretAccessOperation = Extract<VaultOperationClass, 'secret-read' | 'bounded-use'>;

const VAULT_AUDIT_REASONS = [
  'vault_decrypt_failed',
  'fingerprint_verification_failed',
  'vault_reinit_blocked',
  'vault_init_failed',
  'state_entries_mismatch',
  'vault_probe_mismatch',
  'vault_probe_failed',
  'vault_secret_write_failed',
] as const;

export interface VaultAuditDetails {
  key?: string | null;
  found?: boolean;
  entryId?: string;
  latestPerKey?: boolean;
  count?: number;
  reason?: (typeof VAULT_AUDIT_REASONS)[number];
  existingEntries?: number;
  did?: string;
  version?: 1 | 2;
  source?: 'state_guard' | 'raw-entry';
  probe?: 'state-entries-integrity' | 'cipher-cycle';
  entriesChecked?: number;
}

function projectVaultAuditDetails(details: Record<string, unknown>): VaultAuditDetails {
  const safe: VaultAuditDetails = {};
  // References and entry IDs are metadata; credential values never enter these
  // fields. All diagnostic classifications have closed value sets.
  if (details.key === null || typeof details.key === 'string') safe.key = details.key;
  if (typeof details.entryId === 'string') safe.entryId = details.entryId;
  for (const field of ['found', 'latestPerKey'] as const) {
    const value = details[field];
    if (typeof value === 'boolean') safe[field] = value;
  }
  for (const field of ['count', 'existingEntries', 'entriesChecked'] as const) {
    const value = details[field];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) safe[field] = value;
  }
  const reason = details.reason;
  if (VAULT_AUDIT_REASONS.some((candidate) => candidate === reason))
    safe.reason = reason as VaultAuditDetails['reason'];
  if (details.source === 'state_guard' || details.source === 'raw-entry')
    safe.source = details.source;
  if (details.probe === 'cipher-cycle' || details.probe === 'state-entries-integrity')
    safe.probe = details.probe;
  if (details.version === 1 || details.version === 2) safe.version = details.version;
  if (typeof details.did === 'string' && /^did:memphis:[1-9A-HJ-NP-Za-km-z]+$/.test(details.did))
    safe.did = details.did;
  return safe;
}

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
  const safeDetails = projectVaultAuditDetails(details);
  writeSecurityAudit({
    action: `vault.${operation}`,
    status,
    ip: ctx.ip && isIP(ctx.ip) ? ctx.ip : undefined,
    route: ctx.route,
    details: {
      surface: ctx.surface,
      command: ctx.command,
      ...safeDetails,
    },
  });
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

function vaultReadErrorCode(error: unknown): string {
  if (error instanceof VaultStateError) return new VaultStateError(error.code).code;
  if (error instanceof VaultEntryError) return new VaultEntryError(error.code).code;
  if (
    error instanceof AppError &&
    (error.code === 'BRIDGE_UNAVAILABLE' || error.code === 'BRIDGE_LOAD_FAILURE')
  )
    return error.code;
  return 'VAULT_SECRET_READ_FAILED';
}

function accessVaultSecretByKey(
  key: string,
  ctx: VaultAuditContext,
  operation: VaultSecretAccessOperation,
  rawEnv: NodeJS.ProcessEnv = process.env,
): VaultSecretReadResult {
  try {
    const secret = readLatestVaultSecret(key, rawEnv);
    if (!secret) {
      writeVaultAudit(ctx, operation, 'allowed', { key, found: false });
      return { found: false, key };
    }
    writeVaultAudit(ctx, operation, 'allowed', {
      key,
      found: true,
      entryId: secret.entry.id,
    });
    return {
      found: true,
      key,
      plaintext: secret.plaintext,
      createdAt: secret.entry.createdAt,
    };
  } catch (error) {
    const integrity =
      error instanceof VaultEntryError && error.code === 'VAULT_ENTRY_INTEGRITY_FAILED';
    const errorCode = vaultReadErrorCode(error);
    writeVaultAudit(ctx, operation, integrity ? 'blocked' : 'error', {
      key,
      reason: integrity ? 'fingerprint_verification_failed' : 'vault_decrypt_failed',
    });
    return {
      found: true,
      key,
      errorCode,
      error: integrity
        ? 'Vault entry integrity verification failed'
        : 'Vault entry decryption failed',
    };
  }
}

export function readVaultSecretByKey(
  key: string,
  ctx: VaultAuditContext,
  rawEnv: NodeJS.ProcessEnv = process.env,
): VaultSecretReadResult {
  return accessVaultSecretByKey(key, ctx, 'secret-read', rawEnv);
}

/**
 * Internal credential-use helper. The callback is trusted code: it can retain,
 * return or throw the value. This is not a secrecy boundary or a public tool
 * API. Public diagnostic operations must construct fixed, secret-free DTOs.
 * The audit event proves decryption, not callback completion.
 */
export class VaultSecretUnavailableError extends Error {
  readonly vaultKey: string;
  constructor(
    vaultKey: string,
    reason: string,
    readonly errorCode?: string,
  ) {
    super(`Vault secret "${vaultKey}" unavailable: ${reason}`);
    this.name = 'VaultSecretUnavailableError';
    this.vaultKey = vaultKey;
  }
}

export function withVaultSecret<T>(
  key: string,
  ctx: VaultAuditContext,
  fn: (plaintext: string) => T,
  rawEnv: NodeJS.ProcessEnv = process.env,
): T {
  const result = accessVaultSecretByKey(key, ctx, 'bounded-use', rawEnv);
  if (!result.found)
    throw new VaultSecretUnavailableError(key, 'no vault entry found', 'VAULT_ENTRY_NOT_FOUND');
  if (result.error) throw new VaultSecretUnavailableError(key, result.error, result.errorCode);
  return fn(result.plaintext!);
}

export class VaultInitializationError extends Error {
  readonly code = 'VAULT_INITIALIZATION_FAILED';
  constructor() {
    super('Vault initialization failed; run memphis doctor to check configuration.');
    this.name = 'VaultInitializationError';
  }
}

export function initializeVault(
  input: VaultInitInput,
  ctx: VaultAuditContext,
  rawEnv: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof vaultInit> {
  const force = parseBool(rawEnv.MEMPHIS_VAULT_FORCE_REINIT, false);
  const existingEntries = listVaultEntries(rawEnv);
  if (!force && existingEntries.length > 0) {
    writeVaultAudit(ctx, 'vault-init', 'blocked', {
      reason: 'vault_reinit_blocked',
      existingEntries: existingEntries.length,
    });
    throw new VaultAlreadyInitializedError(
      `Vault has ${existingEntries.length} existing entries — refusing re-init. ` +
        `A new master key would leave them unreadable. ` +
        `Set MEMPHIS_VAULT_FORCE_REINIT=1 only if you intentionally want to wipe the vault. ` +
        `See docs/operator/FORCE-FLAGS.md for the full bypass contract.`,
    );
  }

  try {
    const out = vaultInit(input, rawEnv);
    writeVaultAudit(ctx, 'vault-init', 'allowed', {
      did: out.did,
      version: out.version,
    });
    return out;
  } catch (error) {
    if (error instanceof VaultAlreadyInitializedError) {
      // Re-throw with the same audit verdict the entries-guard would have produced.
      writeVaultAudit(ctx, 'vault-init', 'blocked', {
        reason: 'vault_reinit_blocked',
        source: 'state_guard',
      });
      throw error;
    }
    writeVaultAudit(ctx, 'vault-init', 'error', {
      reason: 'vault_init_failed',
    });
    if (error instanceof VaultStateError) throw new VaultStateError(error.code);
    if (
      error instanceof AppError &&
      (error.code === 'BRIDGE_UNAVAILABLE' || error.code === 'BRIDGE_LOAD_FAILURE')
    ) {
      throw new AppError(
        error.code,
        'Vault bridge unavailable; rebuild the native bridge and run memphis doctor.',
        503,
      );
    }
    throw new VaultInitializationError();
  }
}

export type VaultIntegrityProbeResult =
  | { ok: true; entriesChecked: number }
  | { ok: false; brokenKeys: string[]; entriesChecked: number; reason: string };

/**
 * Cross-check that every persisted vault entry can still be decrypted with
 * the current state. Run at startup BEFORE the HTTP server opens its port.
 *
 * Why: the silent-overwrite class of bug — `vault_init` invoked while
 * entries.json already had secrets, generating a fresh master key, leaving
 * entries unrecoverable — went undetected for 7 hours in 2026-04-25 because
 * runtime probing only verified a *fresh* probe entry (cipher-cycle), not
 * existing entries. By decrypting the latest entry per key at boot, we catch
 * the mismatch immediately and refuse to start, instead of pretending health
 * is green while every saved secret is dead.
 *
 * Cost: O(unique-keys) NAPI roundtrips at boot. Production vaults today have
 * <10 keys; tested with up to 1000 entries (one per minute log) and the probe
 * stays under 50ms.
 */
export function probeVaultStateEntriesIntegrity(
  ctx: VaultAuditContext,
  rawEnv: NodeJS.ProcessEnv = process.env,
): VaultIntegrityProbeResult {
  const all = listVaultEntries(rawEnv);
  if (all.length === 0) {
    // No entries persisted — nothing to verify. A fresh install is fine.
    return { ok: true, entriesChecked: 0 };
  }

  const seenKeys = new Set<string>();
  const brokenKeys: string[] = [];
  const brokenCauses: Record<string, string> = {};

  for (const entry of all) {
    if (seenKeys.has(entry.key)) continue;
    seenKeys.add(entry.key);
    try {
      readLatestVaultSecret(entry.key, rawEnv);
    } catch (error) {
      brokenKeys.push(entry.key);
      brokenCauses[entry.key] =
        error instanceof VaultEntryError && error.code === 'VAULT_ENTRY_INTEGRITY_FAILED'
          ? 'integrity_verify_failed'
          : 'vault_decrypt_failed';
    }
  }

  if (brokenKeys.length > 0) {
    writeVaultAudit(ctx, 'bounded-use', 'error', {
      probe: 'state-entries-integrity',
      brokenKeys,
      brokenCauses,
      entriesChecked: seenKeys.size,
      reason: 'state_entries_mismatch',
    });
    return {
      ok: false,
      brokenKeys,
      entriesChecked: seenKeys.size,
      reason:
        `Vault state cannot decrypt ${brokenKeys.length} of ${seenKeys.size} entries. ` +
        `Likely cause: vault_init was invoked while entries.json already had secrets ` +
        `(silent re-init with a fresh master key), or the pepper changed without re-encryption. ` +
        `Restore the latest data/vault-state.json.bak.* matching when these entries were written, ` +
        `or wipe the vault (data/vault-state.json + data/vault-entries.json) and re-add the secrets.`,
    };
  }

  writeVaultAudit(ctx, 'bounded-use', 'allowed', {
    probe: 'state-entries-integrity',
    entriesChecked: seenKeys.size,
  });
  return { ok: true, entriesChecked: seenKeys.size };
}

export function probeVaultCipherCycle(
  ctx: VaultAuditContext,
  rawEnv: NodeJS.ProcessEnv = process.env,
): { ok: true } | { ok: false; error: string } {
  const probe = `vault_probe_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  try {
    const encrypted = vaultEncrypt('__vault_probe__', probe, rawEnv);
    const plaintext = vaultDecrypt(encrypted, rawEnv);
    if (plaintext !== probe) {
      writeVaultAudit(ctx, 'bounded-use', 'error', {
        key: '__vault_probe__',
        probe: 'cipher-cycle',
        reason: 'vault_probe_mismatch',
      });
      return { ok: false, error: 'Vault encryption cycle failed' };
    }

    writeVaultAudit(ctx, 'bounded-use', 'allowed', {
      key: '__vault_probe__',
      probe: 'cipher-cycle',
    });
    return { ok: true };
  } catch {
    writeVaultAudit(ctx, 'bounded-use', 'error', {
      key: '__vault_probe__',
      probe: 'cipher-cycle',
      reason: 'vault_probe_failed',
    });
    return { ok: false, error: 'Vault encryption cycle failed' };
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
): { ok: true; plaintext: string } | { ok: false; error: string; errorCode: string } {
  try {
    const plaintext = vaultDecrypt(entry, rawEnv);
    writeVaultAudit(ctx, 'secret-read', 'allowed', {
      key: entry.key,
      entryId: entry.id,

      source: 'raw-entry',
    });
    return { ok: true, plaintext };
  } catch (error) {
    writeVaultAudit(ctx, 'secret-read', 'error', {
      key: entry.key,
      entryId: entry.id,
      source: 'raw-entry',
      reason: 'vault_decrypt_failed',
    });
    return {
      ok: false,
      error: 'Vault entry decryption failed',
      errorCode: vaultReadErrorCode(error),
    };
  }
}
