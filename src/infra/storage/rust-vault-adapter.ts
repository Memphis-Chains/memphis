import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  hasRequiredBridgeExports,
  loadBridgeModule,
  resolveBridgeContract,
  type BridgeAliasMap,
  type BridgeResolution,
} from './napi-contract.js';

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

interface PersistedVaultState {
  salt: string;
  masterKey: string;
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

function serializeVaultState(vault: JsVault): PersistedVaultState {
  const normalized = normalizeVault(vault);
  return {
    salt: normalized.salt.toString('base64'),
    masterKey: getVaultMasterKey(normalized).toString('base64'),
  };
}

function deserializeVaultState(state: PersistedVaultState): JsVault {
  return {
    salt: Buffer.from(state.salt, 'base64'),
    master_key: Buffer.from(state.masterKey, 'base64'),
  };
}

function persistVaultState(vault: JsVault, rawEnv: NodeJS.ProcessEnv = process.env): void {
  const path = getVaultStatePath(rawEnv);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(serializeVaultState(vault), null, 2));
}

function loadPersistedVaultState(rawEnv: NodeJS.ProcessEnv = process.env): JsVault | null {
  const path = getVaultStatePath(rawEnv);
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, 'utf8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as PersistedVaultState;
    if (
      typeof parsed?.salt !== 'string' ||
      parsed.salt.length === 0 ||
      typeof parsed?.masterKey !== 'string' ||
      parsed.masterKey.length === 0
    ) {
      return null;
    }
    return deserializeVaultState(parsed);
  } catch {
    return null;
  }
}

function getVaultPepper(rawEnv: NodeJS.ProcessEnv): string {
  return (rawEnv.MEMPHIS_VAULT_PEPPER ?? '').trim();
}

function parseBool(v: string | undefined, fallback = false): boolean {
  if (typeof v !== 'string') return fallback;
  return v.toLowerCase() === 'true';
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
  const rustEnabled = parseBool(rawEnv.RUST_CHAIN_ENABLED, false);
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
    throw new Error('RUST_CHAIN_ENABLED=false');
  }
  if (!status.bridgeLoaded || !status.vaultApiAvailable) {
    throw new Error('rust vault bridge unavailable');
  }

  const pepper = getVaultPepper(rawEnv);
  if (pepper.length < 12) {
    throw new Error('MEMPHIS_VAULT_PEPPER missing or too short (min 12 chars)');
  }

  const { newContract, legacyContract } = resolveVaultBridge(rawEnv);
  if (!newContract.bridgeLoaded && !legacyContract.bridgeLoaded) {
    throw new Error('rust vault bridge load failure');
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

  if (typeof bridge.legacyContract.vault_encrypt === 'function') {
    return parseEnvelope<VaultEntry>(bridge.legacyContract.vault_encrypt(key, plaintext));
  }

  throw new Error('vault_store unavailable');
}

export function vaultDecrypt(entry: VaultEntry, rawEnv: NodeJS.ProcessEnv = process.env): string {
  const bridge = getBridgeOrThrow(rawEnv);

  if (typeof bridge.newContract.vault_retrieve === 'function') {
    if (!entry.tag && typeof bridge.legacyContract.vault_decrypt === 'function') {
      const out = parseEnvelope<{ plaintext: string }>(
        bridge.legacyContract.vault_decrypt(JSON.stringify(entry)),
      );
      return out.plaintext;
    }
    const vault = getActiveVaultOrThrow(rawEnv);
    const jsEntry = convertToJsVaultEntry(entry);
    const plaintext = bridge.newContract.vault_retrieve(vault, jsEntry);
    return plaintext.toString('utf8');
  }

  if (typeof bridge.legacyContract.vault_decrypt === 'function') {
    const out = parseEnvelope<{ plaintext: string }>(
      bridge.legacyContract.vault_decrypt(JSON.stringify(entry)),
    );
    return out.plaintext;
  }

  throw new Error('vault_retrieve unavailable');
}
