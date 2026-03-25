/**
 * MatrixClient wrapper for Memphis federation.
 * Handles login, room operations, and message sending/receiving.
 *
 * Note: This is a minimal wrapper. matrix-js-sdk provides the actual
 * Matrix protocol implementation. This wrapper provides Memphis-specific
 * convenience methods and type safety.
 */

import type {
  MatrixCredentials,
  MatrixLoginResponse,
  MatrixRoomInfo,
  MatrixSendResult,
  MatrixMessageEvent,
} from './types.js';

// TODO: key exchange mechanism — HMAC-SHA256 shared secret needs secure distribution
// For v1 pilot, agents use a pre-shared secret via env var:
// MEMPHIS_FEDERATION_SHARED_SECRET=<base64-encoded-key>

/**
 * Matrix client wrapper.
 *
 * Usage:
 * ```typescript
 * const client = new MatrixClient({
 *   homeserver: 'https://m.mem.ph',
 *   userId: '@iskra:m.mem.ph',
 *   accessToken: '...',
 * });
 * await client.connect();
 * await client.joinRoom('#memphis-journal:m.mem.ph');
 * ```
 */
export class MatrixClient {
  private credentials: MatrixCredentials | null = null;
  private connected = false;

  constructor(private readonly credentials_: MatrixCredentials) {
    this.credentials = credentials_;
  }

  /**
   * Validate credentials by checking if we can reach the homeserver.
   * Note: This is NOT a login — credentials are pre-obtained via Element or login().
   */
  async validate(): Promise<boolean> {
    if (!this.credentials) return false;

    try {
      const response = await fetch(
        `${this.credentials.homeserver}/_matrix/client/v3/account/whoami`,
        {
          headers: {
            Authorization: `Bearer ${this.credentials.accessToken}`,
          },
        },
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Login to Matrix homeserver.
   * Note: login() is misleading — it validates credentials, not performs Matrix login.
   * Matrix login is done via Element or admin API to get access token.
   */
  async login(password: string): Promise<MatrixLoginResponse> {
    if (!this.credentials) {
      throw new Error('No credentials configured');
    }

    const response = await fetch(
      `${this.credentials.homeserver}/_matrix/client/v3/login`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'm.login.password',
          identifier: {
            type: 'm.id.user',
            user: this.credentials.userId,
          },
          password,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Matrix login failed: ${response.statusText}`);
    }

    const data = (await response.json()) as MatrixLoginResponse;
    this.credentials.accessToken = data.accessToken;
    this.connected = true;

    return data;
  }

  /**
   * Logout and invalidate credentials.
   */
  async logout(): Promise<void> {
    if (!this.credentials) return;

    await fetch(
      `${this.credentials.homeserver}/_matrix/client/v3/logout`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.credentials.accessToken}`,
        },
      },
    );

    this.connected = false;
    this.credentials = null;
  }

  /**
   * Join a room by ID or alias.
   * EC1: Room discovery — if room doesn't exist, this will fail.
   * TODO: implement ensureRoom() for auto-creation.
   */
  async joinRoom(roomIdOrAlias: string): Promise<string> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }

    const response = await fetch(
      `${this.credentials.homeserver}/_matrix/client/v3/join/${encodeURIComponent(roomIdOrAlias)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.credentials.accessToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to join room ${roomIdOrAlias}: ${response.statusText}`);
    }

    const data = (await response.json()) as { room_id: string };
    return data.room_id;
  }

  /**
   * Leave a room.
   */
  async leaveRoom(roomIdOrAlias: string): Promise<void> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }

    const response = await fetch(
      `${this.credentials.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomIdOrAlias)}/leave`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.credentials.accessToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to leave room ${roomIdOrAlias}: ${response.statusText}`);
    }
  }

  /**
   * Send a message to a room.
   * B4: No retry logic — rate limits, network errors will throw.
   * TODO: implement retry with exponential backoff.
   */
  async sendMessage(roomId: string, content: Record<string, unknown>): Promise<MatrixSendResult> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }

    const txnId = `m${Date.now()}`;
    const response = await fetch(
      `${this.credentials.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${this.credentials.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          msgtype: 'm.text',
          body: content.body ?? JSON.stringify(content),
          ...content,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to send message: ${response.statusText}`);
    }

    const data = (await response.json()) as { event_id: string; timestamp: number };
    return {
      eventId: data.event_id,
      timestamp: new Date(data.timestamp).toISOString(),
    };
  }

  /**
   * Get recent messages from a room.
   * EC3: Token refresh — if token expired, this will fail with 401.
   * TODO: implement token refresh handling.
   */
  async getMessages(roomId: string, limit = 20): Promise<MatrixMessageEvent[]> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }

    const response = await fetch(
      `${this.credentials.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?limit=${limit}&dir=b`,
      {
        headers: {
          Authorization: `Bearer ${this.credentials.accessToken}`,
        },
      },
    );

    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Matrix access token expired — please re-authenticate');
      }
      throw new Error(`Failed to get messages: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      chunk: Array<{
        event_id: string;
        sender: string;
        origin_server_ts: number;
        content: Record<string, unknown>;
        type: string;
      }>;
    };

    return data.chunk.map((event) => ({
      eventId: event.event_id,
      sender: event.sender,
      timestamp: new Date(event.origin_server_ts).toISOString(),
      content: event.content,
      type: event.type,
    }));
  }

  /**
   * Get room information.
   */
  async getRoomInfo(roomIdOrAlias: string): Promise<MatrixRoomInfo> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }

    const response = await fetch(
      `${this.credentials.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomIdOrAlias)}`,
      {
        headers: {
          Authorization: `Bearer ${this.credentials.accessToken}`,
        },
      },
    );

    if (!response.ok) {
      throw new Error(`Failed to get room info: ${response.statusText}`);
    }

    const data = (await response.json()) as {
      room_id: string;
      name?: string;
      topic?: string;
      num_members: number;
      encryption?: string;
    };

    return {
      roomId: data.room_id,
      name: data.name,
      topic: data.topic,
      memberCount: data.num_members,
      isEncrypted: !!data.encryption,
    };
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get userId(): string | undefined {
    return this.credentials?.userId;
  }

  get homeserver(): string | undefined {
    return this.credentials?.homeserver;
  }
}
