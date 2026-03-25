/**
 * Memphis Federation — Matrix integration entry points.
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
