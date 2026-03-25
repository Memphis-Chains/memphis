/**
 * Matrix-specific types for federation integration.
 * Wraps matrix-js-sdk types with Memphis-specific interfaces.
 */

export interface MatrixCredentials {
  homeserver: string;
  userId: string;
  accessToken: string;
}

export interface MatrixRoomInfo {
  roomId: string;
  roomAlias?: string;
  name?: string;
  topic?: string;
  memberCount: number;
  isEncrypted: boolean;
}

export interface MatrixLoginResponse {
  userId: string;
  accessToken: string;
  deviceId: string;
  expiresAt?: number;
}

export interface MatrixSendResult {
  eventId: string;
  timestamp: string;
}

export interface MatrixMessageEvent {
  eventId: string;
  sender: string;
  timestamp: string;
  content: Record<string, unknown>;
  type: string;
}
