/**
 * Operator signing-key access for MP v0 envelopes.
 *
 * MP v0 deliberately uses a SEPARATE Ed25519 keypair from the canonical
 * operator DID minted at `vault init_full`. Reason: the Rust-side
 * `Vault::init_full` (crates/memphis-vault/src/vault.rs:50-77) generates
 * the operator's `did:memphis:` keypair but does NOT persist the encrypted
 * `did_private_key` entry to the TS-side vault entry store — the entry is
 * generated and discarded inside Rust. There is no path today for TS
 * federation code to recover that seed.
 *
 * Rather than ship a Rust migration in H1, MP v0 owns its own seed under
 * vault key `mp_v0_signing_seed`. The seed is base64-encoded for storage
 * (vaultDecrypt round-trips through utf8 strings, which would corrupt
 * raw 32-byte material). On first call, if no seed exists, one is
 * generated, audited, and persisted. The corresponding `did:memphis:z…`
 * is derived deterministically from the seed.
 *
 * H2 reconciliation note: when the Rust vault learns to expose the
 * canonical DID seed to TS, MP v0 should pivot to that seed and
 * deprecate `mp_v0_signing_seed` so the operator has one identity
 * everywhere.
 */

import { randomBytes } from 'node:crypto';

import { didMemphisFromPubkey, __testing } from './envelope.js';
import {
  readVaultSecretByKey,
  storeVaultSecret,
  type VaultAuditContext,
} from '../../security/vault-boundary.js';


export const MP_V0_SIGNING_SEED_KEY = 'mp_v0_signing_seed';

const DEFAULT_AUDIT_CONTEXT: VaultAuditContext = {
  surface: 'system',
  command: 'mp.v0.signing-seed',
};

export type OperatorSigningSeed = {
  /** 32-byte Ed25519 seed. Treat as secret. */
  seed: Buffer;
  /** Operator's MP v0 DID (`did:memphis:z…`), derived from the seed. */
  did: string;
  /** True iff this call generated a fresh seed (first-time init). */
  generated: boolean;
};

/**
 * Read or lazily mint the MP v0 signing seed. Returns the seed as a
 * Buffer (32 bytes) plus the derived DID. If the seed is missing, a new
 * one is generated, persisted via the audited vault boundary, and an
 * audit entry is written.
 *
 * Throws if the vault is not active — federation readiness gates this
 * upstream, so a thrown error here is a programmer bug (called before
 * the vault was unlocked).
 */
export async function getOperatorSigningSeed(
  rawEnv: NodeJS.ProcessEnv = process.env,
  ctx: VaultAuditContext = DEFAULT_AUDIT_CONTEXT,
): Promise<OperatorSigningSeed> {
  const existing = readVaultSecretByKey(MP_V0_SIGNING_SEED_KEY, ctx, rawEnv);
  if (existing.found && existing.plaintext) {
    const seed = decodeSeed(existing.plaintext);
    return {
      seed,
      did: didFromSeed(seed),
      generated: false,
    };
  }
  if (existing.found && existing.error) {
    throw new Error(`mp v0: vault entry for ${MP_V0_SIGNING_SEED_KEY} unreadable: ${existing.error}`);
  }

  const fresh = randomBytes(32);
  storeVaultSecret(MP_V0_SIGNING_SEED_KEY, fresh.toString('base64'), ctx, rawEnv);
  return {
    seed: fresh,
    did: didFromSeed(fresh),
    generated: true,
  };
}

/**
 * Derive the operator's MP v0 DID without exposing the seed. Useful for
 * UI / status surfaces that need to display the DID but should not
 * touch the secret material.
 */
export async function getOperatorDid(
  rawEnv: NodeJS.ProcessEnv = process.env,
  ctx: VaultAuditContext = DEFAULT_AUDIT_CONTEXT,
): Promise<string> {
  const { did } = await getOperatorSigningSeed(rawEnv, ctx);
  return did;
}

function decodeSeed(base64: string): Buffer {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length !== 32) {
    throw new Error(`mp v0: stored seed has ${buf.length} bytes, expected 32`);
  }
  return buf;
}

function didFromSeed(seed: Buffer): string {
  return didMemphisFromPubkey(__testing.pubkeyFromSeed(seed));
}
