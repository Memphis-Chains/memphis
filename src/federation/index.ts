/**
 * Memphis Federation — Matrix integration entry points + MP v0 envelope layer.
 */

export { MatrixClient } from './matrix/client.js';
export { MatrixTransport } from './matrix/sync-adapter.js';
export { MatrixRoom, getOrCreateRoom } from './matrix/room.js';
export type {
  MatrixCredentials,
  MatrixLoginResponse,
  MatrixRoomInfo,
  MatrixSendResult,
  MatrixMessageEvent,
} from './matrix/types.js';

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
  SignedMatrixTransport,
  buildSignedMatrixTransport,
} from './mp/signed-transport.js';
export type {
  MpV0RejectReason,
  SignedMatrixTransportDeps,
  BuildSignedMatrixTransportOptions,
} from './mp/signed-transport.js';

export {
  MP_V0_SIGNING_SEED_KEY,
  getOperatorSigningSeed,
  getOperatorDid,
} from './mp/operator-key.js';
export type { OperatorSigningSeed } from './mp/operator-key.js';
