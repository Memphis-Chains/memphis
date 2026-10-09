/**
 * memphis_wallet_sign — sign a Solana transaction with a vault-held key.
 *
 * Design (2026-10-09): the private key never becomes a field on a tool
 * result. It is decrypted inside `withVaultSecret`, handed straight to the
 * signer, and dropped when the callback returns. What comes back is a
 * signature and the public key — public data.
 *
 * Why this is not `vault_get` + "sign it yourself" in two steps: a key
 * returned to the model is a key in the prompt, which is a key in the
 * provider's request log and in the operator's context window. There is no
 * rollback for a transfer that already happened, so the boundary has to be
 * structural.
 *
 * Solana signatures are Ed25519 over the serialized transaction message.
 * Node's crypto produces exactly the 64-byte format Solana expects, so
 * this needs no web3 dependency.
 */
import { createHash, createPrivateKey, createPublicKey, sign as cryptoSign } from 'node:crypto';

import { isSessionAuthorized } from '../../infra/auth/operator-gate.js';
import { storeDurableMemory } from '../../infra/memory/durable-memory.js';
import { withVaultSecret, VaultSecretUnavailableError } from '../../security/vault-boundary.js';

export type WalletSignInput = {
  /** Vault key holding the base64 32-byte Ed25519 seed. */
  keyName: string;
  /** Base64 transaction message to sign. */
  message: string;
  /** Optional label recorded in the audit entry. */
  label?: string;
};

export type WalletSignOutput = {
  signed: boolean;
  /** Base58 public key of the signing key. */
  publicKey: string;
  /** Base64 signature (64 bytes for Ed25519). */
  signature: string;
  /** SHA-256 of the signed message, hex. */
  messageHash: string;
  keyName: string;
  label?: string;
  error?: string;
};

const SEED_BYTES = 32;
const PUBLIC_KEY_BYTES = 32;
export const WALLET_SIGN_SIGNATURE_BYTES = 64;

/** Base58 (Bitcoin alphabet) — Solana's canonical byte encoding. */
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);

  let out = '';
  while (value > 0n) {
    const mod = value % 58n;
    out = B58_ALPHABET[Number(mod)] + out;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = '1' + out;
  }
  return out === '' ? '1' : out;
}

function base64ToBytes(value: string): Buffer {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error('seed is not valid base64');
  }
  return Buffer.from(normalized, 'base64');
}

/**
 * Wrap a raw 32-byte Ed25519 seed in the PKCS#8 envelope Node's crypto
 * expects. Without this, `createPrivateKey` rejects the raw seed.
 */
function seedToPkcs8(seed: Buffer): Buffer {
  const header = Buffer.from('302e020100300506032b657004220420', 'hex');
  return Buffer.concat([header, seed]);
}

export function runMemphisWalletSign(input: WalletSignInput): WalletSignOutput {
  const base: WalletSignOutput = {
    signed: false,
    publicKey: '',
    signature: '',
    messageHash: '',
    keyName: input.keyName,
    label: input.label,
  };

  if (!isSessionAuthorized()) {
    return {
      ...base,
      error: 'Operator authentication required. Run: memphis operator login',
    };
  }

  if (!input.keyName || input.keyName.trim().length === 0) {
    return { ...base, error: 'keyName is required' };
  }

  let message: Buffer;
  try {
    message = Buffer.from(input.message ?? '', 'base64');
  } catch {
    return { ...base, error: 'message is not valid base64' };
  }
  if (message.length === 0) {
    return { ...base, error: 'message is empty' };
  }

  const messageHash = createHash('sha256').update(message).digest('hex');

  try {
    // The secret exists only inside this callback. It is never assigned to a
    // variable that outlives the call and never reaches the result.
    const signed = withVaultSecret(
      input.keyName,
      { surface: 'mcp', route: 'wallet:sign' },
      (plaintext): { publicKey: string; signature: string } => {
        const seed = base64ToBytes(plaintext);
        if (seed.length !== SEED_BYTES) {
          throw new Error(
            `vault key "${input.keyName}" must hold a ${SEED_BYTES}-byte Ed25519 seed, got ${seed.length} bytes`,
          );
        }

        const privateKey = createPrivateKey({
          key: seedToPkcs8(seed),
          format: 'der',
          type: 'pkcs8',
        });
        const publicKey = createPublicKey(privateKey);
        const rawPublic = publicKey
          .export({ format: 'der', type: 'spki' })
          .subarray(-PUBLIC_KEY_BYTES);
        const signature = cryptoSign(null, message, privateKey);

        return {
          publicKey: base58Encode(new Uint8Array(rawPublic)),
          signature: signature.toString('base64'),
        };
      },
    );

    const result: WalletSignOutput = {
      ...base,
      signed: true,
      publicKey: signed.publicKey,
      signature: signed.signature,
      messageHash,
    };

    // A signature is a financial action — record what was signed, never the key.
    void storeDurableMemory({
      content: [
        `wallet.sign label=${result.label ?? 'unlabelled'} key=${input.keyName}`,
        `pubkey=${result.publicKey}`,
        `messageHash=${result.messageHash}`,
      ].join('\n'),
      tags: ['wallet', 'sign', 'audit'],
      source: 'mcp',
      surface: 'mcp',
    }).catch(() => {
      // An audit write failure must not be reported as a signing failure:
      // the signature already exists and the caller needs it. A missing
      // audit is a separate operational signal.
    });

    return result;
  } catch (e) {
    if (e instanceof VaultSecretUnavailableError) {
      return { ...base, error: e.message };
    }
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}
