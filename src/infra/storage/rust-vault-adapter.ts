import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  hasRequiredBridgeExports,
  loadBridgeModule,
  resolveBridgeContract,
  type BridgeAliasMap,
  type BridgeResolution,
} from './napi-contract.js';
import { parseBool } from '../../core/env.js';
import { errorTemplates } from '../../core/errors.js';
import { writeSecurityAudit } from '../logging/security-audit.js';

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

function getVaultStatePath(rawEnv: NodeJS.ProcessEnv): string {
  return rawEnv.MEMPHIS_VAULT_STATE_PATH ?? './data/vault-state.json';
}

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

function persistVaultState(vault: JsVault, rawEnv: NodeJS.ProcessEnv = process.env): void {
  const statePath = getVaultStatePath(rawEnv);
  const pepper = getVaultPepper(rawEnv);

  mkdirSync(dirname(statePath), { recursive: true });

  if (pepper.length >= 12) {
    const serialized = serializeVaultStateV2(vault, pepper);
    writeFileSync(statePath, JSON.stringify(serialized, null, 2));
  } else {
    // Fallback to v1 if pepper is too short (should not happen in normal flow)
    const normalized = normalizeVault(vault);
    const serialized: PersistedVaultStateV1 = {
      salt: normalized.salt.toString('base64'),
      masterKey: getVaultMasterKey(normalized).toString('base64'),
    };
    writeFileSync(statePath, JSON.stringify(serialized, null, 2));
  }

  try {
    chmodSync(statePath, 0o600);
  } catch {
    // chmod may fail on some platforms (Windows); non-fatal
  }
}

function loadPersistedVaultState(rawEnv: NodeJS.ProcessEnv = process.env): JsVault | null {
  const statePath = getVaultStatePath(rawEnv);
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
  return rawEnv.RUST_CHAIN_BRIDGE_PATH ?? './crates/memphis-napi';
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

  if (tag.length === 0) {
    throw new Error('vault entry missing auth tag; re-add this secret with latest Memphis version');
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

export function vaultInit(
  input: VaultInitInput,
  rawEnv: NodeJS.ProcessEnv = process.env,
): { version: number; did: string } {
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

  throw new Error('vault_store unavailable: new contract vault_store not found. Run: npm run build:rust');
}

export function vaultDecrypt(entry: VaultEntry, rawEnv: NodeJS.ProcessEnv = process.env): string {
  const bridge = getBridgeOrThrow(rawEnv);

  if (typeof bridge.newContract.vault_retrieve === 'function') {
    const vault = getActiveVaultOrThrow(rawEnv);
    const jsEntry = convertToJsVaultEntry(entry);
    const plaintext = bridge.newContract.vault_retrieve(vault, jsEntry);
    return plaintext.toString('utf8');
  }

  throw new Error('vault_retrieve unavailable: new contract vault_retrieve not found. Run: npm run build:rust');
}

/**
 * Reset the in-memory active vault. For testing only.
 */
export function resetActiveVault(): void {
  activeVault = null;
}
