import { createRequire } from 'node:module';

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
}

interface JsVault {
  salt: Buffer;
  master_key: Buffer;
}

interface JsVaultEntry {
  id: string;
  key: string;
  ciphertext: Buffer;
  nonce: Buffer;
  tag: Buffer;
}

interface RustBridgeLike {
  // New NAPI shape
  vaultInit?: (passphrase: string) => JsVault;
  vaultInitFull?: (
    passphrase: string,
    qa_question: string,
    qa_answer: string,
  ) => {
    vault: JsVault;
    did: string;
    qa_question: string;
  };
  vaultStore?: (vault: JsVault, key: string, plaintext: Buffer) => JsVaultEntry;
  vaultRetrieve?: (vault: JsVault, entry: JsVaultEntry) => Buffer;

  // Legacy shape (compat)
  vault_init?: (requestJson: string) => string;
  vault_encrypt?: (key: string, plaintext: string) => string;
  vault_decrypt?: (entryJson: string) => string;
}

interface BridgeEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

let activeVault: JsVault | null = null;

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

function loadBridge(path: string): RustBridgeLike | null {
  try {
    const req = createRequire(`${process.cwd()}/`);
    return req(path) as RustBridgeLike;
  } catch {
    return null;
  }
}

function getActiveVaultOrThrow(): JsVault {
  if (!activeVault) {
    throw new Error('vault not initialized; run vault init first');
  }
  return activeVault;
}

function decodeBase64(value: string): Buffer {
  return Buffer.from(value, 'base64');
}

function convertToJsVaultEntry(entry: VaultEntry): JsVaultEntry {
  return {
    id: '',
    key: entry.key,
    ciphertext: decodeBase64(entry.encrypted),
    nonce: decodeBase64(entry.iv),
    tag: Buffer.alloc(0),
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

export function getRustVaultAdapterStatus(rawEnv: NodeJS.ProcessEnv = process.env): RustVaultAdapterStatus {
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

  const bridge = loadBridge(rustBridgePath);
  if (!bridge) {
    return {
      rustEnabled,
      rustBridgePath,
      bridgeLoaded: false,
      vaultApiAvailable: false,
    };
  }

  const newVaultApiAvailable =
    typeof bridge.vaultInit === 'function' &&
    typeof bridge.vaultStore === 'function' &&
    typeof bridge.vaultRetrieve === 'function';

  const legacyVaultApiAvailable =
    typeof bridge.vault_init === 'function' &&
    typeof bridge.vault_encrypt === 'function' &&
    typeof bridge.vault_decrypt === 'function';

  return {
    rustEnabled,
    rustBridgePath,
    bridgeLoaded: true,
    vaultApiAvailable: newVaultApiAvailable || legacyVaultApiAvailable,
  };
}

function getBridgeOrThrow(rawEnv: NodeJS.ProcessEnv = process.env): RustBridgeLike {
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

  const bridge = loadBridge(status.rustBridgePath);
  if (!bridge) {
    throw new Error('rust vault bridge load failure');
  }
  return bridge;
}

export function vaultInit(input: VaultInitInput, rawEnv: NodeJS.ProcessEnv = process.env): { version: number; did: string } {
  const bridge = getBridgeOrThrow(rawEnv);

  if (typeof bridge.vaultInitFull === 'function') {
    const result = bridge.vaultInitFull(input.passphrase, input.recovery_question, input.recovery_answer);
    activeVault = result.vault;
    return { version: 1, did: result.did };
  }

  if (typeof bridge.vault_init === 'function') {
    return parseEnvelope<{ version: number; did: string }>(bridge.vault_init(JSON.stringify(input)));
  }

  throw new Error('vaultInitFull unavailable');
}

export function vaultEncrypt(
  key: string,
  plaintext: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): VaultEntry {
  const bridge = getBridgeOrThrow(rawEnv);

  if (typeof bridge.vaultStore === 'function') {
    const vault = getActiveVaultOrThrow();
    const entry = bridge.vaultStore(vault, key, Buffer.from(plaintext));
    return {
      key: entry.key,
      encrypted: entry.ciphertext.toString('base64'),
      iv: entry.nonce.toString('base64'),
    };
  }

  if (typeof bridge.vault_encrypt === 'function') {
    return parseEnvelope<VaultEntry>(bridge.vault_encrypt(key, plaintext));
  }

  throw new Error('vaultStore unavailable');
}

export function vaultDecrypt(entry: VaultEntry, rawEnv: NodeJS.ProcessEnv = process.env): string {
  const bridge = getBridgeOrThrow(rawEnv);

  if (typeof bridge.vaultRetrieve === 'function') {
    const vault = getActiveVaultOrThrow();
    const jsEntry = convertToJsVaultEntry(entry);
    const plaintext = bridge.vaultRetrieve(vault, jsEntry);
    return plaintext.toString('utf8');
  }

  if (typeof bridge.vault_decrypt === 'function') {
    const out = parseEnvelope<{ plaintext: string }>(bridge.vault_decrypt(JSON.stringify(entry)));
    return out.plaintext;
  }

  throw new Error('vaultRetrieve unavailable');
}
