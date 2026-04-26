import { createHash } from 'node:crypto';

import { parseBool } from '../core/env.js';
import { writeSecurityAudit } from '../infra/logging/security-audit.js';
import {
  type VaultInitInput,
  type VaultEntry,
  vaultDecrypt,
  vaultEncrypt,
  vaultInit,
  VaultAlreadyInitializedError,
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

type VaultSecretAccessOperation = Extract<VaultOperationClass, 'secret-read' | 'bounded-use'>;

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

function accessVaultSecretByKey(
  key: string,
  ctx: VaultAuditContext,
  operation: VaultSecretAccessOperation,
  rawEnv: NodeJS.ProcessEnv = process.env,
): VaultSecretReadResult {
  const entry = getLatestVaultEntry(key, rawEnv);
  if (!entry) {
    writeVaultAudit(ctx, operation, 'allowed', { key, found: false });
    return { found: false, key };
  }

  if (!verifyVaultEntry(entry)) {
    writeVaultAudit(ctx, operation, 'blocked', {
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
    writeVaultAudit(ctx, operation, 'allowed', {
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
  } catch (e) {
    const cause = e instanceof Error ? e : new Error(String(e));
    writeVaultAudit(ctx, operation, 'error', {
      key,
      found: true,
      entryId: entry.id,
      reason: 'vault_decrypt_failed',
      causeMessage: cause.message,
      causeCode: (e as NodeJS.ErrnoException)?.code,
    });
    return {
      found: true,
      key,
      createdAt: entry.createdAt,
      error: 'Vault entry decryption failed',
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

export function useVaultSecretByKey(
  key: string,
  ctx: VaultAuditContext,
  rawEnv: NodeJS.ProcessEnv = process.env,
): VaultSecretReadResult {
  return accessVaultSecretByKey(key, ctx, 'bounded-use', rawEnv);
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
        `Set MEMPHIS_VAULT_FORCE_REINIT=1 only if you intentionally want to wipe the vault.`,
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
    const innerMessage = error instanceof Error ? error.message : String(error);
    writeVaultAudit(ctx, 'vault-init', 'error', {
      reason: 'vault_init_failed',
      detail: innerMessage,
    });
    // Preserve the original error message so operators see WHY init failed
    // (missing pepper, bridge path, NAPI symbol mismatch, ...) instead of a
    // generic stub. The audit row already redacts secrets; the message is
    // the underlying Rust/bridge error which never contains plaintext.
    throw new Error(`Vault initialization failed: ${innerMessage}`, {
      cause: error,
    });
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
    const latest = getLatestVaultEntry(entry.key, rawEnv);
    if (!latest) continue;
    if (!verifyVaultEntry(latest)) {
      brokenKeys.push(entry.key);
      brokenCauses[entry.key] = 'integrity_verify_failed';
      continue;
    }
    try {
      vaultDecrypt(latest, rawEnv);
    } catch (e) {
      brokenKeys.push(entry.key);
      brokenCauses[entry.key] = e instanceof Error ? e.message : String(e);
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
        plaintextHash: fingerprintHash(plaintext),
      });
      return { ok: false, error: 'Vault encryption cycle failed' };
    }

    writeVaultAudit(ctx, 'bounded-use', 'allowed', {
      key: '__vault_probe__',
      probe: 'cipher-cycle',
      plaintextHash: fingerprintHash(plaintext),
    });
    return { ok: true };
  } catch (e) {
    const cause = e instanceof Error ? e : new Error(String(e));
    writeVaultAudit(ctx, 'bounded-use', 'error', {
      key: '__vault_probe__',
      probe: 'cipher-cycle',
      reason: 'vault_probe_failed',
      causeMessage: cause.message,
      causeCode: (e as NodeJS.ErrnoException)?.code,
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
      plaintextHash: fingerprintHash(plaintext),
    });
    return stored;
  } catch (e) {
    const cause = e instanceof Error ? e : new Error(String(e));
    const causeCode = (e as NodeJS.ErrnoException)?.code;
    writeVaultAudit(ctx, 'secret-write', 'error', {
      key,
      reason: 'vault_secret_write_failed',
      causeMessage: cause.message,
      causeCode,
    });
    throw new Error(`Vault secret write failed: ${cause.message}`, { cause });
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
  } catch (e) {
    const cause = e instanceof Error ? e : new Error(String(e));
    writeVaultAudit(ctx, 'secret-read', 'error', {
      key: entry.key,
      entryId: entry.id,
      source: 'raw-entry',
      reason: 'vault_decrypt_failed',
      causeMessage: cause.message,
      causeCode: (e as NodeJS.ErrnoException)?.code,
    });
    return { ok: false, error: 'Vault entry decryption failed' };
  }
}
