/**
 * Memphis Federation — MP v0 envelope layer (signing + canonicalization).
 * Matrix federation removed in Karpathy refactor sprint 1.
 */

export {
  canonicalize,
  canonicalizeEnvelope,
  didMemphisFromPubkey,
  pubkeyFromDidMemphis,
  signEnvelope,
  verifyEnvelope,
} from './mp/envelope.js';
export type {
  SignedSyncEnvelope,
  VerifyEnvelopeFailureReason,
  VerifyEnvelopeResult,
} from './mp/envelope.js';

export {
  MP_V0_SIGNING_SEED_KEY,
  getOperatorSigningSeed,
  getOperatorDid,
} from './mp/operator-key.js';
export type { OperatorSigningSeed } from './mp/operator-key.js';
