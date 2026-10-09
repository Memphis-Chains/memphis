import { createHash, createPublicKey, verify } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

// 2026-10-09: wallet-sign must hold the seed only inside the callback, so
// the vault boundary is mocked the same way the other vault tests do it.
const { withVaultSecret, VaultSecretUnavailableError, isSessionAuthorized, storeDurableMemory } =
  vi.hoisted(() => {
    class VaultSecretUnavailableError extends Error {
      constructor(key: string, reason: string) {
        super(`Vault secret "${key}" unavailable: ${reason}`);
        this.name = 'VaultSecretUnavailableError';
      }
    }
    return {
      withVaultSecret: vi.fn(),
      VaultSecretUnavailableError,
      isSessionAuthorized: vi.fn(),
      storeDurableMemory: vi.fn(),
    };
  });

vi.mock('../../src/security/vault-boundary.js', () => ({
  withVaultSecret,
  VaultSecretUnavailableError,
}));

vi.mock('../../src/infra/auth/operator-gate.js', () => ({ isSessionAuthorized }));

vi.mock('../../src/infra/memory/durable-memory.js', () => ({ storeDurableMemory }));

import { base58Encode, runMemphisWalletSign } from '../../src/mcp/tools/wallet-sign.js';

/** Deterministic seed so the expected public key is computable here. */
const SEED = Buffer.alloc(32, 7);
const SEED_B64 = SEED.toString('base64');

function seedToPkcs8(seed: Buffer): Buffer {
  return Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
}

function expectedPublicKeyB58(): string {
  const pub = createPublicKey({
    key: seedToPkcs8(SEED),
    format: 'der',
    type: 'pkcs8',
  }).export({ format: 'der', type: 'spki' });
  return base58Encode(new Uint8Array(pub.subarray(-32)));
}

function grantSecret(plaintext: string) {
  withVaultSecret.mockImplementation((_k: string, _c: unknown, fn: (p: string) => unknown) =>
    fn(plaintext),
  );
}

describe('base58Encode', () => {
  it('matches the canonical encoding for known vectors', () => {
    // Published Base58 test vectors.
    expect(base58Encode(new Uint8Array([]))).toBe('1');
    expect(base58Encode(new Uint8Array([0]))).toBe('1');
    expect(base58Encode(new Uint8Array([0, 0, 1]))).toBe('112');
    expect(base58Encode(Buffer.from('hello world'))).toBe('StV1DL6CwTryKyV');
  });
});

describe('memphis_wallet_sign', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isSessionAuthorized.mockReturnValue(true);
    storeDurableMemory.mockResolvedValue({ memoryId: 'x', index: 1, hash: 'h', indexed: true });
  });

  it('produces a signature that verifies against the public key', () => {
    grantSecret(SEED_B64);
    const message = Buffer.from('solana-transaction-message-bytes');

    const result = runMemphisWalletSign({
      keyName: 'wallet_seed',
      message: message.toString('base64'),
    });

    expect(result.error).toBeUndefined();
    expect(result.signed).toBe(true);
    expect(result.publicKey).toBe(expectedPublicKeyB58());
    expect(Buffer.from(result.signature, 'base64')).toHaveLength(64);

    // The real check: does the signature verify? A plausible-looking
    // base64 blob of the right length proves nothing.
    const pub = createPublicKey({
      key: seedToPkcs8(SEED),
      format: 'der',
      type: 'pkcs8',
    });
    expect(verify(null, message, pub, Buffer.from(result.signature, 'base64'))).toBe(true);
  });

  it('hashes the message so the audit entry can be matched to the signature', () => {
    grantSecret(SEED_B64);
    const message = Buffer.from('abc');
    const result = runMemphisWalletSign({
      keyName: 'wallet_seed',
      message: message.toString('base64'),
    });
    expect(result.messageHash).toBe(createHash('sha256').update(message).digest('hex'));
  });

  it('never puts the seed or key material on the result', () => {
    grantSecret(SEED_B64);
    const result = runMemphisWalletSign({ keyName: 'wallet_seed', message: 'AAAA' });

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(SEED_B64);
    expect(serialised).not.toContain(SEED.toString('hex'));
    // The seed is base64; its raw hex must not appear anywhere either.
    expect(Object.keys(result)).not.toContain('plaintext');
  });

  it('records an audit entry without the secret', async () => {
    grantSecret(SEED_B64);
    runMemphisWalletSign({ keyName: 'wallet_seed', message: 'AAAA', label: 'rent' });
    await vi.waitFor(() => expect(storeDurableMemory).toHaveBeenCalled());
    const entry = storeDurableMemory.mock.calls[0][0];
    expect(entry.tags).toContain('wallet');
    expect(entry.content).toContain('pubkey=');
    expect(entry.content).toContain('messageHash=');
    expect(entry.content).toContain('label=rent');
    expect(entry.content).not.toContain(SEED_B64);
  });

  it('refuses without an authorized session', () => {
    isSessionAuthorized.mockReturnValue(false);
    const result = runMemphisWalletSign({ keyName: 'wallet_seed', message: 'AAAA' });
    expect(result.signed).toBe(false);
    expect(result.error).toMatch(/authentication required/i);
    expect(withVaultSecret).not.toHaveBeenCalled();
  });

  it('reports an unavailable vault key without signing', () => {
    withVaultSecret.mockImplementation(() => {
      throw new VaultSecretUnavailableError('wallet_seed', 'no vault entry found');
    });
    const result = runMemphisWalletSign({ keyName: 'wallet_seed', message: 'AAAA' });
    expect(result.signed).toBe(false);
    expect(result.error).toMatch(/unavailable/);
    expect(result.signature).toBe('');
  });

  it('rejects a seed of the wrong length instead of signing with it', () => {
    grantSecret(Buffer.alloc(16, 3).toString('base64'));
    const result = runMemphisWalletSign({ keyName: 'wallet_seed', message: 'AAAA' });
    expect(result.signed).toBe(false);
    expect(result.error).toMatch(/32-byte Ed25519 seed/);
  });

  it('rejects a seed that is not base64', () => {
    grantSecret('not base64 !!!');
    const result = runMemphisWalletSign({ keyName: 'wallet_seed', message: 'AAAA' });
    expect(result.signed).toBe(false);
    expect(result.error).toMatch(/base64/);
  });

  it('rejects an empty message', () => {
    grantSecret(SEED_B64);
    const result = runMemphisWalletSign({ keyName: 'wallet_seed', message: '' });
    expect(result.signed).toBe(false);
    expect(result.error).toMatch(/empty/i);
    expect(withVaultSecret).not.toHaveBeenCalled();
  });

  it('rejects a missing key name', () => {
    grantSecret(SEED_B64);
    const result = runMemphisWalletSign({ keyName: '', message: 'AAAA' });
    expect(result.signed).toBe(false);
    expect(result.error).toMatch(/keyName is required/);
  });
});
