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

interface RustBridgeLike {
  vault_init?: (requestJson: string) => string;
  vault_encrypt?: (key: string, plaintext: string) => string;
  vault_decrypt?: (entryJson: string) => string;
}

interface BridgeEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: string;
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

function loadBridge(path: string): RustBridgeLike | null {
  try {
    const req = createRequire(`${process.cwd()}/`);
    return req(path) as RustBridgeLike;
  } catch {
    return null;
  }
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

  const vaultApiAvailable =
    typeof bridge.vault_init === 'function' &&
    typeof bridge.vault_encrypt === 'function' &&
    typeof bridge.vault_decrypt === 'function';

  return {
    rustEnabled,
    rustBridgePath,
    bridgeLoaded: true,
    vaultApiAvailable,
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

export function vaultInit(input: VaultInitInput, rawEnv: NodeJS.ProcessEnv = process.env): { version: number; did: string } {
  const bridge = getBridgeOrThrow(rawEnv);
  if (typeof bridge.vault_init !== 'function') {
    throw new Error('vault_init unavailable');
  }

  return parseEnvelope<{ version: number; did: string }>(bridge.vault_init(JSON.stringify(input)));
}

export function vaultEncrypt(
  key: string,
  plaintext: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): VaultEntry {
  const bridge = getBridgeOrThrow(rawEnv);
  if (typeof bridge.vault_encrypt !== 'function') {
    throw new Error('vault_encrypt unavailable');
  }

  return parseEnvelope<VaultEntry>(bridge.vault_encrypt(key, plaintext));
}

export function vaultDecrypt(entry: VaultEntry, rawEnv: NodeJS.ProcessEnv = process.env): string {
  const bridge = getBridgeOrThrow(rawEnv);
  if (typeof bridge.vault_decrypt !== 'function') {
    throw new Error('vault_decrypt unavailable');
  }

  const out = parseEnvelope<{ plaintext: string }>(bridge.vault_decrypt(JSON.stringify(entry)));
  return out.plaintext;
}
