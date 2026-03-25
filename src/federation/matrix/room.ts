/**
 * Matrix room abstraction for Memphis federation.
 * Provides room-level operations for join, leave, and message handling.
 */

import type { MatrixClient } from './client.js';
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
 * EC1: Room discovery — if room doesn't exist, create it.
 * TODO: implement ensureRoom() for auto-creation.
 */
export async function getOrCreateRoom(
  client: MatrixClient,
  roomIdOrAlias: string,
): Promise<MatrixRoom> {
  const roomId = await client.joinRoom(roomIdOrAlias);
  return new MatrixRoom(client, roomId);
}
