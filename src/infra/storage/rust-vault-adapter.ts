import { createCipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { dirname } from 'node:path';

import {
  hasRequiredBridgeExports,
  loadPlatformAwareBridge,
  resolveBridgeContract,
  type BridgeAliasMap,
  type BridgeResolution,
} from './napi-contract.js';
import type { StoredVaultEntry } from './vault-entry-store.js';
import { resolveVaultJournals, resolveVaultPath } from './vault-paths.js';
import { parseBool } from '../../core/env.js';
import { errorTemplates } from '../../core/errors.js';
import {
  commitConfigurationTransaction,
  configurationFileHash,
  recoverConfigurationTransaction,
  withConfigurationSnapshot,
  withConfigurationWriteLock,
} from '../config/config-transaction.js';
import { writePrivateAtomicFile } from '../config/private-atomic-file.js';
import { writeSecurityAudit } from '../logging/security-audit.js';
import { resolveRustBridgePath } from '../runtime/install-root.js';

export interface RustVaultAdapterStatus {
  rustEnabled: boolean;
  rustBridgePath: string;
  bridgeLoaded: boolean;
  vaultApiAvailable: boolean;
}

export interface VaultInitInput {
  passphrase: string;
  recovery_question: string;
  recovery_answer: string;
}

export interface VaultEntry {
  key: string;
  encrypted: string;
  iv: string;
  id?: string;
  tag?: string;
  createdAt?: string;
}

interface JsVault {
  salt: Buffer;
  master_key?: Buffer;
  masterKey?: Buffer;
}

interface JsVaultEntry {
  id: string;
  key: string;
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
  created_at?: string;
  createdAt?: string;
}

const NEW_VAULT_BRIDGE_ALIASES = {
  vault_init_full: ['vault_init_full', 'vaultInitFull'],
  vault_store: ['vault_store', 'vaultStore'],
  vault_retrieve: ['vault_retrieve', 'vaultRetrieve'],
  vault_load_state: ['vault_load_state', 'vaultLoadState'],
  vault_parse_entries: ['vault_parse_entries', 'vaultParseEntries'],
  vault_decode_entry: ['vault_decode_entry', 'vaultDecodeEntry'],
} satisfies BridgeAliasMap<
  | 'vault_init_full'
  | 'vault_store'
  | 'vault_retrieve'
  | 'vault_load_state'
  | 'vault_parse_entries'
  | 'vault_decode_entry'
>;

const LEGACY_VAULT_BRIDGE_ALIASES = {
  vault_init_json: ['vault_init_json', 'vault_init', 'vaultInitJson'],
  vault_encrypt: ['vault_encrypt', 'vaultEncrypt'],
  vault_decrypt: ['vault_decrypt', 'vaultDecrypt'],
} satisfies BridgeAliasMap<'vault_init_json' | 'vault_encrypt' | 'vault_decrypt'>;

type NewVaultBridgeKey = keyof typeof NEW_VAULT_BRIDGE_ALIASES;
type LegacyVaultBridgeKey = keyof typeof LEGACY_VAULT_BRIDGE_ALIASES;

interface EntryBridgeResult {
  entries_json?: string;
  entriesJson?: string;
  entry?: JsVaultEntry;
  error_code?: string;
  errorCode?: string;
}

interface ResolvedNewVaultBridge {
  vault_parse_entries?: (
    raw: string,
    key: string | undefined,
    latest: boolean,
  ) => EntryBridgeResult;
  vault_decode_entry?: (raw: string) => EntryBridgeResult;
  vault_init_full?: (
    passphrase: string,
    qa_question: string,
    qa_answer: string,
  ) => {
    vault: JsVault;
    did: string;
    qa_question: string;
  };
  vault_load_state?: (
    path: string,
    pepper: string,
  ) => {
    vault?: JsVault;
    version?: number;
    error_code?: string;
    errorCode?: string;
  };
  vault_store?: (vault: JsVault, key: string, plaintext: Buffer) => JsVaultEntry;
  vault_retrieve?: (vault: JsVault, entry: JsVaultEntry) => Buffer;
}

interface ResolvedLegacyVaultBridge {
  vault_init_json?: (requestJson: string) => string;
  vault_encrypt?: (key: string, plaintext: string) => string;
  vault_decrypt?: (entryJson: string) => string;
}

interface BridgeEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

// v1 format: plaintext base64 master key (no version field)
interface PersistedVaultStateV1 {
  salt: string;
  masterKey: string;
}

// v2 format: encrypted master key with AES-256-GCM
interface PersistedVaultStateV2 {
  version: 2;
  salt: string;
  encryptedMasterKey: string;
  iv: string;
  tag: string;
}

export class VaultStateError extends Error {
  readonly code: string;

  constructor(code: string) {
    const messages: Record<string, string> = {
      VAULT_STATE_MISSING: 'vault state not found',
      VAULT_STATE_UNREADABLE: 'vault state cannot be read',
      VAULT_STATE_MALFORMED: 'vault state is malformed',
      VAULT_STATE_UNSUPPORTED_VERSION: 'unsupported vault state version',
      VAULT_PEPPER_REQUIRED: 'MEMPHIS_VAULT_PEPPER missing or too short (min 12 chars)',
      VAULT_STATE_AUTH_FAILED: 'failed to decrypt vault state',
    };
    const safeCode = Object.hasOwn(messages, code) ? code : 'VAULT_STATE_READER_UNAVAILABLE';
    super(
      `${safeCode}: ${messages[safeCode] ?? 'vault state reader unavailable; rebuild Rust bridge'}`,
    );
    this.code = safeCode;
    this.name = 'VaultStateError';
  }
}

function readVaultState(rawEnv: NodeJS.ProcessEnv, pepper = getVaultPepper(rawEnv)) {
  const { newContract } = resolveVaultBridge(rawEnv);
  const loader = (newContract.resolved as ResolvedNewVaultBridge).vault_load_state;
  if (!loader) throw new VaultStateError('VAULT_STATE_READER_UNAVAILABLE');
  const result = loader(resolveVaultPath('vault-state.json', rawEnv), pepper);
  const code = result.error_code ?? result.errorCode;
  if (code) throw new VaultStateError(code);
  if (!result.vault || (result.version !== 1 && result.version !== 2)) {
    throw new VaultStateError('VAULT_STATE_MALFORMED');
  }
  return { vault: normalizeVault(result.vault), version: result.version as 1 | 2 };
}

let activeVault: JsVault | null = null;
let activeVaultIdentity: string | null = null;

function getVaultMasterKey(vault: JsVault): Buffer {
  const key = vault.master_key ?? vault.masterKey;
  if (!key) {
    throw new Error('vault state missing master key');
  }
  return key;
}

function normalizeVault(vault: JsVault): JsVault {
  return {
    salt: vault.salt,
    master_key: getVaultMasterKey(vault),
  };
}

function deriveStateEncryptionKey(pepper: string): Buffer {
  return scryptSync(pepper, 'memphis-vault-state-v2', 32, {
    N: 16384,
    r: 8,
    p: 1,
  }) as Buffer;
}

function serializeVaultStateV2(vault: JsVault, pepper: string): PersistedVaultStateV2 {
  const normalized = normalizeVault(vault);
  const masterKeyBytes = getVaultMasterKey(normalized);
  const encKey = deriveStateEncryptionKey(pepper);
  const iv = randomBytes(12);

  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  const encrypted = Buffer.concat([cipher.update(masterKeyBytes), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 2,
    salt: normalized.salt.toString('base64'),
    encryptedMasterKey: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

/**
 * Snapshot the existing vault state to a sibling backup before overwrite.
 *
 * Why: every vault-state.json overwrite is potentially destructive — if the
 * caller is wrong (smoke test, reinit-while-state-exists, partial rotation),
 * the encrypted master key in the previous file is the ONLY way to decrypt
 * existing entries. Without a snapshot, the recovery cost is "wipe vault
 * and re-add every secret manually." With a snapshot, recovery is "restore
 * the latest .bak.{ts}" plus the original pepper.
 *
 * Keeps last 10 snapshots, sorted by mtime; older ones are unlinked.
 */
function snapshotVaultStateBeforeWrite(statePath: string): void {
  if (!existsSync(statePath)) return;
  const dir = dirname(statePath);
  const base = statePath.split('/').pop()!;
  const ts = Date.now();
  const backupPath = `${statePath}.bak.${ts}`;
  try {
    copyFileSync(statePath, backupPath);
    chmodSync(backupPath, 0o600);
  } catch {
    // Backup is a safety net — never block the write itself if the snapshot fails.
    return;
  }

  // Prune older backups, keep last 10.
  try {
    const fsSync = readdirSync(dir);
    const candidates = fsSync
      .filter((name) => name.startsWith(`${base}.bak.`))
      .map((name) => {
        const tsPart = name.slice(`${base}.bak.`.length);
        return { name, ts: Number(tsPart) || 0 };
      })
      .filter((entry) => entry.ts > 0)
      .sort((a, b) => b.ts - a.ts);
    const KEEP = 10;
    for (let i = KEEP; i < candidates.length; i += 1) {
      try {
        unlinkSync(`${dir}/${candidates[i].name}`);
      } catch {
        // Best effort.
      }
    }
  } catch {
    // Pruning failure is non-fatal.
  }
}

function persistVaultState(vault: JsVault, rawEnv: NodeJS.ProcessEnv = process.env): void {
  const statePath = resolveVaultPath('vault-state.json', rawEnv);
  const pepper = getVaultPepper(rawEnv);
  mkdirSync(dirname(statePath), { recursive: true });
  snapshotVaultStateBeforeWrite(statePath);

  if (pepper.length >= 12) {
    writePrivateAtomicFile(
      statePath,
      JSON.stringify(serializeVaultStateV2(vault, pepper), null, 2),
    );
  } else {
    const normalized = normalizeVault(vault);
    const serialized: PersistedVaultStateV1 = {
      salt: normalized.salt.toString('base64'),
      masterKey: getVaultMasterKey(normalized).toString('base64'),
    };
    writePrivateAtomicFile(statePath, JSON.stringify(serialized, null, 2));
  }
}

function getVaultPepper(rawEnv: NodeJS.ProcessEnv): string {
  return (rawEnv.MEMPHIS_VAULT_PEPPER ?? '').trim();
}

function getBridgePath(rawEnv: NodeJS.ProcessEnv): string {
  // Delegated to the shared `resolveRustBridgePath()` helper after PR #306
  // exposed the cwd-vs-installRoot bug here. Centralising the resolution
  // ensures vault, chain, embed, doctor, and graceful-shutdown all agree
  // on which bridge to load.
  return resolveRustBridgePath(rawEnv);
}

function resolveVaultBridge(rawEnv: NodeJS.ProcessEnv = process.env): {
  rustBridgePath: string;
  newContract: BridgeResolution<NewVaultBridgeKey>;
  legacyContract: BridgeResolution<LegacyVaultBridgeKey>;
} {
  const rustBridgePath = getBridgePath(rawEnv);
  // S9-1b: try platform sub-package first (`@memphis-chains/memphis-<triple>`),
  // fall back to the in-tree bridge path. Behaviour-zero pre-publish; once
  // sub-packages exist on the registry (S9-3 pipeline), this picks them up
  // automatically without further code changes.
  const bridge = loadPlatformAwareBridge(rustBridgePath);
  return {
    rustBridgePath,
    newContract: resolveBridgeContract(bridge, NEW_VAULT_BRIDGE_ALIASES),
    legacyContract: resolveBridgeContract(bridge, LEGACY_VAULT_BRIDGE_ALIASES),
  };
}

function vaultCacheIdentity(rawEnv: NodeJS.ProcessEnv): string {
  const path = resolveVaultPath('vault-state.json', rawEnv);
  // Hash stays process-local. Include file content to detect atomic replacement,
  // even when inode timestamps or file size are unchanged.
  let state: Buffer;
  try {
    state = readFileSync(path);
  } catch (error) {
    throw new VaultStateError(
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'VAULT_STATE_MISSING'
        : 'VAULT_STATE_UNREADABLE',
    );
  }
  return createHash('sha256')
    .update(JSON.stringify([path, getVaultPepper(rawEnv), rawEnv.MEMPHIS_CONFIG_GENERATION ?? '0']))
    .update(state)
    .digest('hex');
}

function getActiveVaultOrThrow(rawEnv: NodeJS.ProcessEnv = process.env): JsVault {
  try {
    return loadActiveVault(rawEnv);
  } catch (error) {
    // A missing, unreadable or rejected replacement must release the old key,
    // even if this attempt never reaches the native decoder.
    resetActiveVault();
    throw error;
  }
}

function loadActiveVault(rawEnv: NodeJS.ProcessEnv): JsVault {
  const journals = resolveVaultJournals(rawEnv).paths;
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = withConfigurationSnapshot(journals, () => {
      const identity = vaultCacheIdentity(rawEnv);
      if (activeVaultIdentity !== identity) resetActiveVault();
      return { identity, vault: activeVault };
    });
    if (snapshot.vault) return normalizeVault(snapshot.vault);

    // Do the expensive KDF outside the lock, then validate the snapshot before
    // publishing its key. A rotation must never give an old key a new identity.
    const loaded = readVaultState(rawEnv);
    let published = false;
    try {
      const current = withConfigurationSnapshot(journals, () => {
        if (vaultCacheIdentity(rawEnv) !== snapshot.identity) return null;
        if (loaded.version === 1 && getVaultPepper(rawEnv).length >= 12) {
          persistVaultState(loaded.vault, rawEnv);
          writeSecurityAudit({
            action: 'vault.state.upgrade',
            status: 'allowed',
            details: { from: 'v1', to: 'v2', reason: 'transparent upgrade on load' },
          });
        }
        const identity = vaultCacheIdentity(rawEnv);
        activeVault = normalizeVault(loaded.vault);
        activeVaultIdentity = identity;
        published = true;
        return activeVault;
      });
      if (current) return current;
    } finally {
      if (!published) getVaultMasterKey(loaded.vault).fill(0);
    }
  }
  throw new Error('Vault state changed during loading; retry operation');
}

/** Preload outside the lock, then pin state and entry reads to that generation. */
export function withVaultReadSnapshot<T>(
  read: () => T,
  rawEnv: NodeJS.ProcessEnv = process.env,
): T {
  const journals = resolveVaultJournals(rawEnv).paths;
  for (let attempt = 0; attempt < 3; attempt++) {
    getActiveVaultOrThrow(rawEnv);
    const identity = activeVaultIdentity;
    const snapshot = withConfigurationSnapshot(journals, () => {
      if (vaultCacheIdentity(rawEnv) !== identity) return { current: false } as const;
      return { current: true, value: read() } as const;
    });
    if (snapshot.current) return snapshot.value;
  }
  throw new Error('Vault state changed during loading; retry operation');
}

export class VaultEntryError extends Error {
  readonly code: string;
  constructor(code: string) {
    const messages: Record<string, string> = {
      VAULT_ENTRIES_UNREADABLE: 'vault entries cannot be read',
      VAULT_ENTRIES_MALFORMED: 'vault entries are malformed',
      VAULT_ENTRY_NOT_FOUND: 'vault entry not found',
      VAULT_ENTRY_INTEGRITY_FAILED: 'vault entry integrity verification failed',
      VAULT_ENTRY_AUTH_FAILED: 'vault entry decryption failed',
      VAULT_ENTRY_INVALID_TEXT: 'vault entry is not valid UTF-8',
    };
    const safeCode = Object.hasOwn(messages, code) ? code : 'VAULT_ENTRY_READER_UNAVAILABLE';
    super(
      `${safeCode}: ${messages[safeCode] ?? 'vault entry reader unavailable; rebuild Rust bridge'}`,
    );
    this.name = 'VaultEntryError';
    this.code = safeCode;
  }
}

export function parseVaultEntries(
  raw: string,
  rawEnv: NodeJS.ProcessEnv,
  key?: string,
  latest = false,
): StoredVaultEntry[] {
  const parser = (resolveVaultBridge(rawEnv).newContract.resolved as ResolvedNewVaultBridge)
    .vault_parse_entries;
  if (!parser) throw new VaultEntryError('VAULT_ENTRY_READER_UNAVAILABLE');
  const result = parser(raw, key, latest);
  const code = result.error_code ?? result.errorCode;
  if (code) throw new VaultEntryError(code);
  const json = result.entries_json ?? result.entriesJson;
  if (typeof json !== 'string') throw new VaultEntryError('VAULT_ENTRIES_MALFORMED');
  return JSON.parse(json) as StoredVaultEntry[];
}

function convertToJsVaultEntry(entry: VaultEntry, rawEnv: NodeJS.ProcessEnv): JsVaultEntry {
  const decoder = (resolveVaultBridge(rawEnv).newContract.resolved as ResolvedNewVaultBridge)
    .vault_decode_entry;
  if (!decoder) throw new VaultEntryError('VAULT_ENTRY_READER_UNAVAILABLE');
  const result = decoder(JSON.stringify(entry));
  const code = result.error_code ?? result.errorCode;
  if (code) throw new VaultEntryError(code);
  if (!result.entry) throw new VaultEntryError('VAULT_ENTRIES_MALFORMED');
  return result.entry;
}

function parseEnvelope<T>(raw: string): T {
  const out = JSON.parse(raw) as BridgeEnvelope<T>;
  if (!out.ok) {
    throw new Error(out.error ?? 'rust bridge error');
  }
  if (out.data === undefined) {
    throw new Error('rust bridge returned empty data');
  }
  return out.data;
}

export function getRustVaultAdapterStatus(
  rawEnv: NodeJS.ProcessEnv = process.env,
): RustVaultAdapterStatus {
  const rustEnabled = parseBool(rawEnv.RUST_CHAIN_ENABLED);
  const rustBridgePath = getBridgePath(rawEnv);

  if (!rustEnabled) {
    return {
      rustEnabled,
      rustBridgePath,
      bridgeLoaded: false,
      vaultApiAvailable: false,
    };
  }

  const { newContract, legacyContract } = resolveVaultBridge(rawEnv);
  if (!newContract.bridgeLoaded && !legacyContract.bridgeLoaded) {
    return {
      rustEnabled,
      rustBridgePath,
      bridgeLoaded: false,
      vaultApiAvailable: false,
    };
  }

  const newVaultApiAvailable = hasRequiredBridgeExports(newContract, [
    'vault_init_full',
    'vault_store',
    'vault_retrieve',
    'vault_load_state',
    'vault_parse_entries',
    'vault_decode_entry',
  ]);

  const legacyVaultApiAvailable = hasRequiredBridgeExports(legacyContract, [
    'vault_init_json',
    'vault_encrypt',
    'vault_decrypt',
  ]);

  return {
    rustEnabled,
    rustBridgePath,
    bridgeLoaded: true,
    vaultApiAvailable: newVaultApiAvailable || legacyVaultApiAvailable,
  };
}

function getBridgeOrThrow(
  rawEnv: NodeJS.ProcessEnv = process.env,
  requirePepper = true,
): {
  newContract: ResolvedNewVaultBridge;
  legacyContract: ResolvedLegacyVaultBridge;
} {
  const status = getRustVaultAdapterStatus(rawEnv);
  if (!status.rustEnabled) {
    throw errorTemplates.bridgeUnavailable({
      component: 'Vault',
      bridgePath: status.rustBridgePath,
      message:
        'Vault requires Rust bridge. Set RUST_CHAIN_ENABLED=true and run: npm run build:rust',
    });
  }
  if (!status.bridgeLoaded || !status.vaultApiAvailable) {
    throw errorTemplates.bridgeUnavailable({
      component: 'Vault',
      bridgePath: status.rustBridgePath,
      message: `Rust vault bridge not found at ${status.rustBridgePath}. Run: npm run build:rust`,
    });
  }

  const pepper = getVaultPepper(rawEnv);
  if (requirePepper && pepper.length < 12) {
    throw new VaultStateError('VAULT_PEPPER_REQUIRED');
  }

  const { newContract, legacyContract } = resolveVaultBridge(rawEnv);
  if (!newContract.bridgeLoaded && !legacyContract.bridgeLoaded) {
    throw errorTemplates.bridgeLoadFailure({
      component: 'Vault',
      bridgePath: status.rustBridgePath,
      message: `Rust vault bridge at ${status.rustBridgePath} loaded but missing required exports. Rebuild: npm run build:rust`,
    });
  }

  return {
    newContract: newContract.resolved as ResolvedNewVaultBridge,
    legacyContract: legacyContract.resolved as ResolvedLegacyVaultBridge,
  };
}

/**
 * Thrown when vault_init is called but a vault state already exists. This is
 * a hard guard against the silent-overwrite class of bug where a smoke test
 * or stray HTTP probe re-inits the vault and leaves entries unrecoverable.
 *
 * Triggered EVERY time a non-empty state.json is present at the configured
 * path. The only override is the explicit env flag MEMPHIS_VAULT_FORCE_REINIT=1
 * which the operator must set deliberately and will wipe-by-design.
 */
export class VaultAlreadyInitializedError extends Error {
  readonly code = 'VAULT_ALREADY_INITIALIZED';
  constructor(message: string) {
    super(message);
    this.name = 'VaultAlreadyInitializedError';
  }
}

function refuseIfVaultDataExists(rawEnv: NodeJS.ProcessEnv): void {
  if (parseBool(rawEnv.MEMPHIS_VAULT_FORCE_REINIT, false)) return;
  for (const file of ['vault-state.json', 'vault-entries.json'] as const) {
    const path = resolveVaultPath(file, rawEnv);
    try {
      const raw = readFileSync(path, 'utf8').trim();
      if (file === 'vault-state.json' && !raw) continue;
      if (file === 'vault-entries.json') {
        const entries: unknown = JSON.parse(raw);
        if (Array.isArray(entries) && entries.length === 0) continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // Unreadable or malformed data is not an empty vault. Preserve it for
      // recovery instead of silently replacing the key that could unlock it.
    }
    throw new VaultAlreadyInitializedError(
      `Vault data already exists or cannot be read at ${path}. ` +
        `Refusing to re-initialize — this would generate a new master key and ` +
        `leave existing encrypted entries unreadable. ` +
        `If you intentionally want to wipe the vault, set MEMPHIS_VAULT_FORCE_REINIT=1. ` +
        `See docs/operator/FORCE-FLAGS.md for the full bypass contract.`,
    );
  }
}

export function vaultInit(
  input: VaultInitInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): { version: number; did: string } {
  const journalPath = resolveVaultJournals(rawEnv).paths;
  return withConfigurationWriteLock(journalPath, () => {
    refuseIfVaultDataExists(rawEnv);
    return initializeVaultUnderLock(input, rawEnv);
  });
}

function initializeVaultUnderLock(
  input: VaultInitInput,
  rawEnv: NodeJS.ProcessEnv,
): { version: number; did: string } {
  const bridge = getBridgeOrThrow(rawEnv);

  if (typeof bridge.newContract.vault_init_full === 'function') {
    const result = bridge.newContract.vault_init_full(
      input.passphrase,
      input.recovery_question,
      input.recovery_answer,
    );
    const vault = normalizeVault(result.vault);
    persistVaultState(vault, rawEnv);
    resetActiveVault();
    activeVault = vault;
    activeVaultIdentity = vaultCacheIdentity(rawEnv);
    return { version: 1, did: result.did };
  }

  if (typeof bridge.legacyContract.vault_init_json === 'function') {
    const result = parseEnvelope<unknown>(
      bridge.legacyContract.vault_init_json(JSON.stringify(input)),
    );
    // A TS type assertion does not strip private fields from a legacy ABI result.
    // Keep the public result explicit; the Rust compatibility payload is unchanged.
    if (!result || typeof result !== 'object') {
      throw new Error('invalid legacy vault initialization result');
    }
    const { version, did } = result as Record<string, unknown>;
    if ((version !== 1 && version !== 2) || typeof did !== 'string' || !did.trim()) {
      throw new Error('invalid legacy vault initialization result');
    }
    return { version, did };
  }

  throw new Error('vault_init_full unavailable');
}

export function vaultEncrypt(
  key: string,
  plaintext: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): VaultEntry {
  const bridge = getBridgeOrThrow(rawEnv, false);

  if (typeof bridge.newContract.vault_store === 'function') {
    const vault = getActiveVaultOrThrow(rawEnv);
    const entry = bridge.newContract.vault_store(vault, key, Buffer.from(plaintext));
    return {
      key: entry.key,
      encrypted: entry.ciphertext.toString('base64'),
      iv: entry.nonce.toString('base64'),
      id: entry.id,
      tag: entry.tag.toString('base64'),
      createdAt: entry.createdAt ?? entry.created_at,
    };
  }

  throw new Error(
    'vault_store unavailable: new contract vault_store not found. Run: npm run build:rust',
  );
}

export function vaultDecrypt(entry: VaultEntry, rawEnv: NodeJS.ProcessEnv = process.env): string {
  const bridge = getBridgeOrThrow(rawEnv, false);

  if (typeof bridge.newContract.vault_retrieve === 'function') {
    const vault = getActiveVaultOrThrow(rawEnv);
    const jsEntry = convertToJsVaultEntry(entry, rawEnv);
    let plaintext: Buffer;
    try {
      plaintext = bridge.newContract.vault_retrieve(vault, jsEntry);
    } catch {
      throw new VaultEntryError('VAULT_ENTRY_AUTH_FAILED');
    }
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintext);
    } catch {
      throw new VaultEntryError('VAULT_ENTRY_INVALID_TEXT');
    }
  }

  throw new Error(
    'vault_retrieve unavailable: new contract vault_retrieve not found. Run: npm run build:rust',
  );
}

/** Release key material after invalidation, rotation or a failed reload. */
export function resetActiveVault(): void {
  if (activeVault) getVaultMasterKey(activeVault).fill(0);
  activeVault = null;
  activeVaultIdentity = null;
}

export interface VaultPepperRotateResult {
  statePath: string;
  fromVersion: 1 | 2;
  toVersion: 2;
}

export function rotateVaultStatePepper(
  oldPepper: string,
  newPepper: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): VaultPepperRotateResult {
  if (newPepper.length < 12) {
    throw new Error('New pepper must be at least 12 characters.');
  }
  if (oldPepper === newPepper) {
    throw new Error('New pepper must differ from old pepper.');
  }

  const statePath = resolveVaultPath('vault-state.json', rawEnv);
  if (!existsSync(statePath)) {
    throw new Error(`Vault state not found at ${statePath}. Run "memphis vault init" first.`);
  }

  const { vault, version: fromVersion } = readVaultState(rawEnv, oldPepper);

  try {
    const wrapped = serializeVaultStateV2(vault, newPepper);
    writePrivateAtomicFile(statePath, JSON.stringify(wrapped, null, 2));
    return { statePath, fromVersion, toVersion: 2 };
  } finally {
    getVaultMasterKey(vault).fill(0);
    resetActiveVault();
  }
}

export interface VaultMasterKeyRotateFailure {
  key: string;
  id?: string;
  reason: string;
}

export interface VaultMasterKeyRotateResult {
  statePath: string;
  entriesPath: string;
  rotatedCount: number;
}

function getEntriesStorePath(rawEnv: NodeJS.ProcessEnv): string {
  return resolveVaultPath('vault-entries.json', rawEnv);
}

/** Read the same persisted entry contract used by normal credential reads.
 * Missing files represent an empty vault; existing malformed files must abort.
 */
export function loadEntriesForRotationOrThrow(
  entriesPath: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): StoredVaultEntry[] {
  let raw: string;
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      readFileSync(entriesPath),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new VaultEntryError('VAULT_ENTRIES_UNREADABLE');
  }
  return parseVaultEntries(raw, rawEnv);
}

export function rotateVaultMasterKey(
  rawEnv: NodeJS.ProcessEnv = process.env,
): VaultMasterKeyRotateResult {
  const statePath = resolveVaultPath('vault-state.json', rawEnv);
  const entriesPath = getEntriesStorePath(rawEnv);

  const journalPath = resolveVaultJournals(rawEnv).paths;
  recoverConfigurationTransaction(journalPath);
  const originalStateHash = configurationFileHash(statePath);
  const originalEntriesHash = configurationFileHash(entriesPath);

  if (!existsSync(statePath)) {
    throw new Error(`Vault state not found at ${statePath}. Run "memphis vault init" first.`);
  }

  // Rotation publishes v2 transactionally. A transparent v1 upgrade here would
  // mutate the state after capturing its expected hash and invalidate the plan.
  const oldVault = readVaultState(rawEnv).vault;

  const bridge = getBridgeOrThrow(rawEnv);
  if (
    typeof bridge.newContract.vault_store !== 'function' ||
    typeof bridge.newContract.vault_retrieve !== 'function'
  ) {
    throw new Error(
      'Vault bridge missing vault_store / vault_retrieve exports. Run: npm run build:rust',
    );
  }

  // CRITICAL: do not swallow parse/read errors on an existing entries file.
  // Treating a corrupt vault-entries.json as "empty" causes rotation to
  // continue and then rewrite the file with [], silently destroying the
  // ciphertext records. When the file exists and can't be parsed, abort the
  // rotation so the operator can investigate (or restore from a backup)
  // before touching the live vault.
  const entries = loadEntriesForRotationOrThrow(entriesPath, rawEnv);

  const decrypted: Array<{ key: string; plaintext: Buffer; createdAt?: string }> = [];
  const failed: VaultMasterKeyRotateFailure[] = [];

  for (const entry of entries) {
    try {
      const jsEntry = convertToJsVaultEntry(entry, rawEnv);
      const plaintext = bridge.newContract.vault_retrieve(oldVault, jsEntry);
      decrypted.push({ key: entry.key, plaintext, createdAt: entry.createdAt });
    } catch {
      failed.push({
        key: entry.key,
        id: entry.id,
        reason: 'credential-decryption-failed',
      });
    }
  }

  if (failed.length > 0) {
    for (const record of decrypted) record.plaintext.fill(0);
    const summary = failed
      .slice(0, 5)
      .map((f) => `  • key=${f.key} id=${f.id ?? '(none)'} — ${f.reason}`)
      .join('\n');
    throw new Error(
      `Master-key rotation aborted: ${failed.length} entr${failed.length === 1 ? 'y' : 'ies'} could not be decrypted under the current master key. ` +
        `Delete or repair them first (memphis vault entry-delete --key <name> --confirm), then retry.\n${summary}`,
    );
  }

  const newVault = {
    salt: oldVault.salt,
    master_key: randomBytes(32),
  };

  try {
    const reencrypted = decrypted.map((record) => {
      const out = bridge.newContract.vault_store!(newVault, record.key, record.plaintext);
      return {
        id: out.id,
        key: out.key,
        encrypted: out.ciphertext.toString('base64'),
        iv: out.nonce.toString('base64'),
        tag: out.tag.toString('base64'),
        createdAt: record.createdAt ?? out.createdAt ?? out.created_at ?? new Date().toISOString(),
      };
    });

    const reencryptedStored = reencrypted.map((e) => {
      const payload = JSON.stringify({ key: e.key, encrypted: e.encrypted, iv: e.iv });
      const fingerprint = createHash('sha256').update(payload).digest('hex');
      return { ...e, fingerprint };
    });

    const pepper = getVaultPepper(rawEnv);
    if (pepper.length < 12)
      throw new Error('MEMPHIS_VAULT_PEPPER must be at least 12 characters to write v2 state.');
    const wrapped = serializeVaultStateV2(newVault, pepper);
    mkdirSync(dirname(entriesPath), { recursive: true, mode: 0o700 });
    commitConfigurationTransaction(journalPath, [
      {
        path: statePath,
        content: JSON.stringify(wrapped, null, 2),
        expectedHash: originalStateHash,
      },
      {
        path: entriesPath,
        content: JSON.stringify(reencryptedStored, null, 2),
        expectedHash: originalEntriesHash,
      },
    ]);
    return { statePath, entriesPath, rotatedCount: reencryptedStored.length };
  } finally {
    resetActiveVault();
    for (const record of decrypted) record.plaintext.fill(0);
    newVault.master_key.fill(0);
  }
}
