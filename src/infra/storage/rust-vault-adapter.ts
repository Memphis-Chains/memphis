import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import {
  hasRequiredBridgeExports,
  loadBridgeModule,
  resolveBridgeContract,
  type BridgeAliasMap,
  type BridgeResolution,
} from './napi-contract.js';
import { resolveVaultPath } from './vault-paths.js';
import { parseBool } from '../../core/env.js';
import { errorTemplates } from '../../core/errors.js';
import { writeSecurityAudit } from '../logging/security-audit.js';
import { resolveRustBridgePath } from '../runtime/install-root.js';

/**
 * fsync a file so writes are durable on disk. Used between
 * writeFileSync(tmp) and renameSync(tmp, live) during vault rotation
 * (#145). Silently tolerates platforms/filesystems where fsync isn't
 * available — the rename itself is still the primary durability
 * barrier, fsync just closes the crash-between-write-and-rename window.
 */
function fsyncFile(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r+');
    fsyncSync(fd);
  } catch (err) {
    // Best-effort; proceed with the rename even if fsync isn't supported
    // (e.g. tmpfs, network mount). Sprint 2.4: surface to stderr so the
    // operator notices durability degradation — silent swallow used to
    // mean nobody could tell whether vault writes were actually durable
    // until a power-cut audit. Stderr instead of pino so this module
    // stays free of logger dependencies (loaded during shutdown paths
    // where pino transports may already be torn down).
    process.stderr.write(
      `[memphis-vault] fsync(${path}) failed — durability degraded for this write: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // noop
      }
    }
  }
}

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
} satisfies BridgeAliasMap<'vault_init_full' | 'vault_store' | 'vault_retrieve'>;

const LEGACY_VAULT_BRIDGE_ALIASES = {
  vault_init_json: ['vault_init_json', 'vault_init', 'vaultInitJson'],
  vault_encrypt: ['vault_encrypt', 'vaultEncrypt'],
  vault_decrypt: ['vault_decrypt', 'vaultDecrypt'],
} satisfies BridgeAliasMap<'vault_init_json' | 'vault_encrypt' | 'vault_decrypt'>;

type NewVaultBridgeKey = keyof typeof NEW_VAULT_BRIDGE_ALIASES;
type LegacyVaultBridgeKey = keyof typeof LEGACY_VAULT_BRIDGE_ALIASES;

interface ResolvedNewVaultBridge {
  vault_init_full?: (
    passphrase: string,
    qa_question: string,
    qa_answer: string,
  ) => {
    vault: JsVault;
    did: string;
    qa_question: string;
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

type PersistedVaultState = PersistedVaultStateV1 | PersistedVaultStateV2;

function isV2State(state: PersistedVaultState): state is PersistedVaultStateV2 {
  return 'version' in state && state.version === 2;
}

let activeVault: JsVault | null = null;

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

function deserializeVaultStateV2(state: PersistedVaultStateV2, pepper: string): JsVault | null {
  try {
    const encKey = deriveStateEncryptionKey(pepper);
    const iv = Buffer.from(state.iv, 'base64');
    const encrypted = Buffer.from(state.encryptedMasterKey, 'base64');
    const tag = Buffer.from(state.tag, 'base64');

    const decipher = createDecipheriv('aes-256-gcm', encKey, iv);
    decipher.setAuthTag(tag);
    const masterKey = Buffer.concat([decipher.update(encrypted), decipher.final()]);

    return {
      salt: Buffer.from(state.salt, 'base64'),
      master_key: masterKey,
    };
  } catch {
    return null;
  }
}

function deserializeVaultStateV1(state: PersistedVaultStateV1): JsVault {
  return {
    salt: Buffer.from(state.salt, 'base64'),
    master_key: Buffer.from(state.masterKey, 'base64'),
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
    const serialized = serializeVaultStateV2(vault, pepper);
    // Sprint 2.2 (#275): create with 0600 mode at write time so there's
    // no umask-window where the file is world-readable. Previous logic
    // used default mode + chmod-after — race-prone on multi-user hosts.
    writeFileSync(statePath, JSON.stringify(serialized, null, 2), { mode: 0o600 });
  } else {
    // Fallback to v1 if pepper is too short (should not happen in normal flow)
    const normalized = normalizeVault(vault);
    const serialized: PersistedVaultStateV1 = {
      salt: normalized.salt.toString('base64'),
      masterKey: getVaultMasterKey(normalized).toString('base64'),
    };
    writeFileSync(statePath, JSON.stringify(serialized, null, 2), { mode: 0o600 });
  }

  // Belt-and-suspenders: tighten if the file existed before this write
  // (writeFileSync `mode` only applies to file creation, not overwrite).
  try {
    chmodSync(statePath, 0o600);
  } catch {
    // chmod may fail on some platforms (Windows); non-fatal
  }
}

function loadPersistedVaultState(rawEnv: NodeJS.ProcessEnv = process.env): JsVault | null {
  const statePath = resolveVaultPath('vault-state.json', rawEnv);
  if (!existsSync(statePath)) return null;

  try {
    const raw = readFileSync(statePath, 'utf8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as PersistedVaultState;

    let vault: JsVault | null = null;

    if (isV2State(parsed)) {
      const pepper = getVaultPepper(rawEnv);
      if (pepper.length < 12) {
        throw new Error('MEMPHIS_VAULT_PEPPER required to decrypt v2 vault state');
      }
      vault = deserializeVaultStateV2(parsed, pepper);
    } else {
      // v1: plaintext base64
      if (
        typeof parsed?.salt !== 'string' ||
        parsed.salt.length === 0 ||
        typeof parsed?.masterKey !== 'string' ||
        parsed.masterKey.length === 0
      ) {
        return null;
      }
      vault = deserializeVaultStateV1(parsed);

      // Transparent upgrade: re-persist as v2 if pepper is available
      const pepper = getVaultPepper(rawEnv);
      if (vault && pepper.length >= 12) {
        persistVaultState(vault, rawEnv);
        writeSecurityAudit({
          action: 'vault.state.upgrade',
          status: 'allowed',
          details: { from: 'v1', to: 'v2', reason: 'transparent upgrade on load' },
        });
      }
    }

    return vault;
  } catch {
    return null;
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
  const bridge = loadBridgeModule(rustBridgePath);
  return {
    rustBridgePath,
    newContract: resolveBridgeContract(bridge, NEW_VAULT_BRIDGE_ALIASES),
    legacyContract: resolveBridgeContract(bridge, LEGACY_VAULT_BRIDGE_ALIASES),
  };
}

function getActiveVaultOrThrow(rawEnv: NodeJS.ProcessEnv = process.env): JsVault {
  if (!activeVault) {
    activeVault = loadPersistedVaultState(rawEnv);
  }
  if (!activeVault) {
    throw new Error('vault not initialized; run vault init first');
  }
  activeVault = normalizeVault(activeVault);
  return activeVault;
}

function decodeBase64(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

function convertToJsVaultEntry(entry: VaultEntry): JsVaultEntry {
  const tag = entry.tag ? decodeBase64(entry.tag) : Buffer.alloc(0);

  // v1 entries (created before Memphis 0.4.0): tag is empty but ciphertext
  // includes the GCM auth tag at the last 16 bytes. Rust's retrieve() handles
  // this format inline. Only throw for entries that have empty tag AND
  // ciphertext that is too short to contain a valid tag (genuinely corrupt).
  if (tag.length === 0 && entry.encrypted) {
    const ciphertextBytes = decodeBase64(entry.encrypted);
    if (ciphertextBytes.length <= 16) {
      const entryId = entry.id ? ` (id: ${entry.id})` : '';
      const entryKey = entry.key ? ` (key: ${entry.key})` : '';
      throw new Error(
        `Vault entry${entryId}${entryKey} appears corrupt — empty tag and ciphertext ` +
          'is too short to contain a valid auth tag.',
      );
    }
    // v1 format: pass through with empty tag; Rust handles it
  }

  return {
    id: entry.id && entry.id.trim().length > 0 ? entry.id : `entry-${Date.now()}`,
    key: entry.key,
    ciphertext: decodeBase64(entry.encrypted),
    nonce: decodeBase64(entry.iv),
    tag,
    created_at: entry.createdAt ?? new Date().toISOString(),
    createdAt: entry.createdAt ?? new Date().toISOString(),
  };
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

function getBridgeOrThrow(rawEnv: NodeJS.ProcessEnv = process.env): {
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
  if (pepper.length < 12) {
    throw new Error('MEMPHIS_VAULT_PEPPER missing or too short (min 12 chars)');
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

function refuseIfVaultStateExists(rawEnv: NodeJS.ProcessEnv): void {
  if (parseBool(rawEnv.MEMPHIS_VAULT_FORCE_REINIT, false)) return;
  const statePath = resolveVaultPath('vault-state.json', rawEnv);
  if (!existsSync(statePath)) return;
  let raw: string;
  try {
    raw = readFileSync(statePath, 'utf8').trim();
  } catch {
    return;
  }
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  const obj = parsed as Record<string, unknown> | null;
  const hasSalt = typeof obj?.salt === 'string' && (obj.salt as string).length > 0;
  const hasKey =
    (typeof obj?.encryptedMasterKey === 'string' &&
      (obj.encryptedMasterKey as string).length > 0) ||
    (typeof obj?.masterKey === 'string' && (obj.masterKey as string).length > 0);
  if (hasSalt && hasKey) {
    throw new VaultAlreadyInitializedError(
      `Vault state already initialized at ${statePath}. ` +
        `Refusing to re-initialize — this would generate a new master key and ` +
        `leave existing encrypted entries unreadable. ` +
        `If you intentionally want to wipe the vault, set MEMPHIS_VAULT_FORCE_REINIT=1.`,
    );
  }
}

export function vaultInit(
  input: VaultInitInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): { version: number; did: string } {
  refuseIfVaultStateExists(rawEnv);
  const bridge = getBridgeOrThrow(rawEnv);

  if (typeof bridge.newContract.vault_init_full === 'function') {
    const result = bridge.newContract.vault_init_full(
      input.passphrase,
      input.recovery_question,
      input.recovery_answer,
    );
    activeVault = normalizeVault(result.vault);
    persistVaultState(activeVault, rawEnv);
    return { version: 1, did: result.did };
  }

  if (typeof bridge.legacyContract.vault_init_json === 'function') {
    return parseEnvelope<{ version: number; did: string }>(
      bridge.legacyContract.vault_init_json(JSON.stringify(input)),
    );
  }

  throw new Error('vault_init_full unavailable');
}

export function vaultEncrypt(
  key: string,
  plaintext: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): VaultEntry {
  const bridge = getBridgeOrThrow(rawEnv);

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
  const bridge = getBridgeOrThrow(rawEnv);

  if (typeof bridge.newContract.vault_retrieve === 'function') {
    const vault = getActiveVaultOrThrow(rawEnv);
    const jsEntry = convertToJsVaultEntry(entry);
    const plaintext = bridge.newContract.vault_retrieve(vault, jsEntry);
    return plaintext.toString('utf8');
  }

  throw new Error(
    'vault_retrieve unavailable: new contract vault_retrieve not found. Run: npm run build:rust',
  );
}

/**
 * Reset the in-memory active vault. For testing only.
 */
export function resetActiveVault(): void {
  activeVault = null;
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

  const raw = readFileSync(statePath, 'utf8');
  const parsed = JSON.parse(raw) as PersistedVaultState;

  let vault: JsVault;
  let fromVersion: 1 | 2;
  if (isV2State(parsed)) {
    fromVersion = 2;
    const unwrapped = deserializeVaultStateV2(parsed, oldPepper);
    if (!unwrapped) {
      throw new Error(
        'Failed to decrypt vault state with the provided OLD pepper. Either the pepper is wrong or the state is corrupt.',
      );
    }
    vault = unwrapped;
  } else {
    fromVersion = 1;
    vault = deserializeVaultStateV1(parsed);
  }

  const wrapped = serializeVaultStateV2(vault, newPepper);
  const tmpPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(wrapped, null, 2));
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // chmod non-fatal on some platforms
  }
  renameSync(tmpPath, statePath);

  activeVault = normalizeVault(vault);

  return { statePath, fromVersion, toVersion: 2 };
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

/**
 * Load and validate the entries JSON before a master-key rotation.
 *
 * Exported for regression-test access: guarantees that a corrupt or missing
 * entries file aborts rotation loudly rather than getting silently
 * reinterpreted as empty (which would cause `rotateVaultMasterKey` to
 * overwrite every stored ciphertext record with `[]`).
 */
export function loadEntriesForRotationOrThrow(
  entriesPath: string,
): Array<VaultEntry & { createdAt?: string; fingerprint?: string }> {
  if (!existsSync(entriesPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(entriesPath, 'utf8');
  } catch (err) {
    throw new Error(
      `Master-key rotation aborted: cannot read ${entriesPath} — ${err instanceof Error ? err.message : String(err)}. ` +
        `Fix the file (check permissions or restore from backup) before retrying.`,
    );
  }
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Master-key rotation aborted: ${entriesPath} is not valid JSON — ${err instanceof Error ? err.message : String(err)}. ` +
        `Restore a valid entries file from backup before retrying; rotation will not silently discard ciphertext records.`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Master-key rotation aborted: ${entriesPath} must contain a JSON array of entries, got ${typeof parsed}. ` +
        `Restore a valid entries file from backup before retrying.`,
    );
  }
  return parsed as Array<VaultEntry & { createdAt?: string; fingerprint?: string }>;
}

export function rotateVaultMasterKey(
  rawEnv: NodeJS.ProcessEnv = process.env,
): VaultMasterKeyRotateResult {
  const statePath = resolveVaultPath('vault-state.json', rawEnv);
  const entriesPath = getEntriesStorePath(rawEnv);

  if (!existsSync(statePath)) {
    throw new Error(`Vault state not found at ${statePath}. Run "memphis vault init" first.`);
  }

  const oldVault = loadPersistedVaultState(rawEnv);
  if (!oldVault) {
    throw new Error(
      `Failed to load vault state from ${statePath}. Check MEMPHIS_VAULT_PEPPER matches the state.`,
    );
  }

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
  const entries = loadEntriesForRotationOrThrow(entriesPath);

  const decrypted: Array<{ key: string; plaintext: Buffer; createdAt?: string }> = [];
  const failed: VaultMasterKeyRotateFailure[] = [];

  for (const entry of entries) {
    try {
      const jsEntry = convertToJsVaultEntry(entry);
      const plaintext = bridge.newContract.vault_retrieve(oldVault, jsEntry);
      decrypted.push({ key: entry.key, plaintext, createdAt: entry.createdAt });
    } catch (err) {
      failed.push({
        key: entry.key,
        id: entry.id,
        reason: err instanceof Error ? err.message : 'unknown_error',
      });
    }
  }

  if (failed.length > 0) {
    const summary = failed
      .slice(0, 5)
      .map((f) => `  • key=${f.key} id=${f.id ?? '(none)'} — ${f.reason}`)
      .join('\n');
    throw new Error(
      `Master-key rotation aborted: ${failed.length} entr${failed.length === 1 ? 'y' : 'ies'} could not be decrypted under the current master key. ` +
        `Delete or repair them first (memphis vault entry-delete --key <name> --confirm), then retry.\n${summary}`,
    );
  }

  const newVault: JsVault = {
    salt: oldVault.salt,
    master_key: randomBytes(32),
  };

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

  const stateBackup = `${statePath}.bak-${process.pid}-${Date.now()}`;
  const entriesBackup = `${entriesPath}.bak-${process.pid}-${Date.now()}`;

  copyFileSync(statePath, stateBackup);
  if (existsSync(entriesPath)) {
    copyFileSync(entriesPath, entriesBackup);
  }

  const tmpState = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  const tmpEntries = `${entriesPath}.tmp-${process.pid}-${Date.now()}`;

  try {
    const pepper = getVaultPepper(rawEnv);
    if (pepper.length < 12) {
      throw new Error('MEMPHIS_VAULT_PEPPER must be at least 12 characters to write v2 state.');
    }
    const wrapped = serializeVaultStateV2(newVault, pepper);
    // Sprint 2.2 (#275): create with 0600 at write time (closes umask race).
    writeFileSync(tmpState, JSON.stringify(wrapped, null, 2), { mode: 0o600 });
    try {
      chmodSync(tmpState, 0o600);
    } catch {
      // chmod non-fatal
    }

    mkdirSync(dirname(entriesPath), { recursive: true });
    writeFileSync(tmpEntries, JSON.stringify(reencryptedStored, null, 2));
    try {
      chmodSync(tmpEntries, 0o600);
    } catch {
      // chmod non-fatal
    }

    // Fsync both tmp files before the first rename (#145). writeFileSync
    // doesn't guarantee durability until the buffer is flushed to disk —
    // a crash between writeFileSync and renameSync could leave a torn
    // tmp that the catch-block rollback then restores from a half-written
    // state. Explicit fsync here closes that window.
    fsyncFile(tmpState);
    fsyncFile(tmpEntries);

    renameSync(tmpState, statePath);
    try {
      renameSync(tmpEntries, entriesPath);
    } catch (entriesRenameErr) {
      copyFileSync(stateBackup, statePath);
      throw entriesRenameErr;
    }

    activeVault = normalizeVault(newVault);

    try {
      unlinkSync(stateBackup);
    } catch {
      // backup cleanup non-fatal
    }
    if (existsSync(entriesBackup)) {
      try {
        unlinkSync(entriesBackup);
      } catch {
        // backup cleanup non-fatal
      }
    }

    return {
      statePath,
      entriesPath,
      rotatedCount: reencryptedStored.length,
    };
  } catch (err) {
    try {
      if (existsSync(tmpState)) unlinkSync(tmpState);
    } catch {
      /* noop */
    }
    try {
      if (existsSync(tmpEntries)) unlinkSync(tmpEntries);
    } catch {
      /* noop */
    }
    if (existsSync(stateBackup)) {
      try {
        copyFileSync(stateBackup, statePath);
        unlinkSync(stateBackup);
      } catch {
        /* noop — backup still on disk for manual recovery */
      }
    }
    if (existsSync(entriesBackup)) {
      try {
        copyFileSync(entriesBackup, entriesPath);
        unlinkSync(entriesBackup);
      } catch {
        /* noop */
      }
    }
    throw err;
  }
}
