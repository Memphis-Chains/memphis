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
import { withRetry, RetryableError } from '../../infra/retry.js';

// Key exchange design (deferred — Matrix native auth is sufficient for pilot threat model):
// Matrix provides TLS + s2s authentication between homeservers. Application-layer HMAC-SHA256
// is only needed for public Matrix federation, defense-in-depth, or compliance. If needed later,
// implement via src/federation/keys/federation-mac.ts with vault-backed key storage
// vault/keys/federation.{peerId}.mac_key. See docs/federation-key-exchange.md.

/**
 * Error with HTTP status code for retry decisions.
 */
export class MatrixError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'MatrixError';
  }
}

/**
 * Matrix client wrapper.
 *
 * Usage:
 * ```typescript
 * const client = new MatrixClient({
 *   homeserver: 'https://m.mem.ph',
 *   userId: 'iskra:m.mem.ph',
 *   accessToken: '...',
 * });
 * await client.connect();
 * await client.joinRoom('#memphis-journal:m.mem.ph');
 * ```
 */
export class MatrixClient {
  private credentials: MatrixCredentials | null = null;
  private connected = false;
  private refreshToken: string | undefined;

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
   * Stores refresh_token when `refreshToken: true` is set, enabling EC3 token refresh.
   */
  async login(password: string, refreshToken = false): Promise<MatrixLoginResponse> {
    if (!this.credentials) {
      throw new Error('No credentials configured');
    }

    const response = await fetch(`${this.credentials.homeserver}/_matrix/client/v3/login`, {
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
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      throw new MatrixError(`Matrix login failed: ${response.statusText}`, response.status);
    }

    const data = (await response.json()) as MatrixLoginResponse & { refresh_token?: string };
    this.credentials.accessToken = data.accessToken;
    this.refreshToken = data.refresh_token;
    this.connected = true;

    return data;
  }

  /**
   * Logout and invalidate credentials.
   */
  async logout(): Promise<void> {
    if (!this.credentials) return;

    await fetch(`${this.credentials.homeserver}/_matrix/client/v3/logout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.credentials.accessToken}`,
      },
    });

    this.connected = false;
    this.credentials = null;
  }

  /**
   * Refresh the access token using the stored refresh token.
   * EC3: Called automatically on 401 errors.
   */
  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshToken) {
      throw new MatrixError('No refresh token available — please re-login', 401);
    }

    const response = await fetch(`${this.credentials!.homeserver}/_matrix/client/v3/tokenrefresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: this.refreshToken }),
    });

    if (!response.ok) {
      throw new MatrixError(`Token refresh failed: ${response.statusText}`, response.status);
    }

    const data = (await response.json()) as { access_token: string; expires_in_ms?: number };
    this.credentials!.accessToken = data.access_token;
  }

  /**
   * Internal request with EC3 token refresh on 401.
   */
  private async requestWithRefresh(
    method: string,
    path: string,
    options: { body?: Record<string, unknown>; token?: string } = {},
  ): Promise<unknown> {
    const token = options.token ?? this.credentials!.accessToken;
    const opts: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };
    if (options.body) {
      opts.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await fetch(`${this.credentials!.homeserver}${path}`, opts);
    } catch (err) {
      // Network error — wrap for retry
      throw new RetryableError(err instanceof Error ? err.message : String(err), 0);
    }

    if (response.status === 401 && options.token === undefined) {
      // First attempt failed with 401 — try refreshing token
      try {
        await this.refreshAccessToken();
        // Retry with new token
        return this.requestWithRefresh(method, path, {
          ...options,
          token: this.credentials!.accessToken,
        });
      } catch {
        // Refresh failed — throw original 401
        throw new MatrixError('Access token expired — please re-authenticate', 401);
      }
    }

    return response;
  }

  /**
   * Join a room by ID or alias.
   * EC1: On 404, caller should create the room and retry.
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
      throw new MatrixError(
        `Failed to join room ${roomIdOrAlias}: ${response.statusText}`,
        response.status,
      );
    }

    const data = (await response.json()) as { room_id: string };
    return data.room_id;
  }

  /**
   * Create a new Matrix room.
   * EC1: Used by getOrCreateRoom() when the room doesn't exist.
   */
  async createRoom(options: {
    roomAliasName: string;
    topic?: string;
  }): Promise<{ roomId: string }> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }

    const response = await fetch(`${this.credentials.homeserver}/_matrix/client/v3/createRoom`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        room_alias_name: options.roomAliasName,
        topic: options.topic ?? '',
      }),
    });

    if (!response.ok) {
      throw new MatrixError(`Failed to create room: ${response.statusText}`, response.status);
    }

    const data = (await response.json()) as { room_id: string };
    return { roomId: data.room_id };
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
      throw new MatrixError(
        `Failed to leave room ${roomIdOrAlias}: ${response.statusText}`,
        response.status,
      );
    }
  }

  /**
   * Send a message to a room.
   * B4: Retries with exponential backoff on network errors and 5xx/429 responses.
   */
  async sendMessage(roomId: string, content: Record<string, unknown>): Promise<MatrixSendResult> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }

    return withRetry(async () => {
      const txnId = `m${Date.now()}`;
      const response = await fetch(
        `${this.credentials!.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${this.credentials!.accessToken}`,
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
        throw new RetryableError(`Failed to send message: ${response.statusText}`, response.status);
      }

      const data = (await response.json()) as { event_id: string; timestamp: number };
      return {
        eventId: data.event_id,
        timestamp: new Date(data.timestamp).toISOString(),
      };
    });
  }

  /**
   * Get recent messages from a room.
   * EC3: Uses token refresh — if token expires mid-session, automatically re-authenticates.
   */
  async getMessages(roomId: string, limit = 20): Promise<MatrixMessageEvent[]> {
    if (!this.credentials) {
      throw new Error('Not connected');
    }

    const response = (await this.requestWithRefresh(
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?limit=${limit}&dir=b`,
    )) as Response;

    if (!response.ok) {
      throw new MatrixError(`Failed to get messages: ${response.statusText}`, response.status);
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
      throw new MatrixError(`Failed to get room info: ${response.statusText}`, response.status);
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
