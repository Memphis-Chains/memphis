/**
 * Matrix room abstraction for Memphis federation.
 * Provides room-level operations for join, leave, and message handling.
 */

import { MatrixClient, MatrixError } from './client.js';
import type { MatrixRoomInfo } from './types.js';

/**
 * Room abstraction for Matrix federation.
 */
export class MatrixRoom {
  constructor(
    private readonly client: MatrixClient,
    private readonly roomId: string,
  ) {}

  /**
   * Get room information.
   */
  async info(): Promise<MatrixRoomInfo> {
    return this.client.getRoomInfo(this.roomId);
  }

  /**
   * Leave this room.
   */
  async leave(): Promise<void> {
    await this.client.leaveRoom(this.roomId);
  }

  /**
   * Send a message to this room.
   */
  async send(content: Record<string, unknown>): Promise<{ eventId: string }> {
    const result = await this.client.sendMessage(this.roomId, content);
    return { eventId: result.eventId };
  }

  get id(): string {
    return this.roomId;
  }
}

/**
 * Create or get a MatrixRoom instance.
 * EC1: Tries to join the room; if it doesn't exist (404), creates it and re-joins.
 */
export async function getOrCreateRoom(
  client: MatrixClient,
  roomIdOrAlias: string,
): Promise<MatrixRoom> {
  try {
    const roomId = await client.joinRoom(roomIdOrAlias);
    return new MatrixRoom(client, roomId);
  } catch (err) {
    if (err instanceof MatrixError && err.status === 404) {
      // Room doesn't exist — create it
      const alias = roomIdOrAlias.replace('#', '').replace(':', '_' + client.homeserver + '_');
      const created = await client.createRoom({ roomAliasName: alias });
      const roomId = await client.joinRoom(created.roomId);
      return new MatrixRoom(client, roomId);
    }
    throw err;
  }
}
