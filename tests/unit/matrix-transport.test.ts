import { describe, expect, it, vi } from 'vitest';

import type { MatrixClient } from '../../src/federation/matrix/client.js';
import { MatrixTransport } from '../../src/federation/matrix/sync-adapter.js';
import type { SyncEnvelope } from '../../src/sync/protocol.js';

function createEnvelope(id: string): SyncEnvelope {
  return {
    id,
    type: 'sync.status',
    senderDid: 'did:peer:matrix',
    ts: '2026-03-26T12:00:00.000Z',
    payload: { ok: true },
  };
}

function createMatrixMessage(envelope: SyncEnvelope) {
  return {
    eventId: `evt-${envelope.id}`,
    sender: envelope.senderDid,
    timestamp: envelope.ts,
    type: 'm.room.message',
    content: {
      body: JSON.stringify(envelope),
      'm.type': envelope.type,
      'm.id': envelope.id,
      'm.sender': envelope.senderDid,
    },
  };
}

describe('MatrixTransport', () => {
  it('deduplicates repeated envelopes returned by polling', async () => {
    const envelope = createEnvelope('env-1');
    let callCount = 0;

    const matrixClient = {
      async getMessages() {
        callCount += 1;
        if (callCount === 2) {
          transport.close();
        }
        return [createMatrixMessage(envelope)];
      },
      sendMessage: vi.fn(),
    } as unknown as MatrixClient;

    const transport = new MatrixTransport(matrixClient, '!room:example');
    (transport as unknown as { pollIntervalMs: number }).pollIntervalMs = 0;

    const received: SyncEnvelope[] = [];
    transport.onMessage((next) => {
      received.push(next);
    });

    await transport.connect();

    expect(callCount).toBe(2);
    expect(received).toEqual([envelope]);
  });

  it('serializes Memphis envelope metadata when sending', async () => {
    const sendMessage = vi.fn();
    const matrixClient = {
      getMessages: vi.fn(),
      sendMessage,
    } as unknown as MatrixClient;

    const transport = new MatrixTransport(matrixClient, '!room:example');
    const envelope = createEnvelope('env-send');

    await transport.send(envelope);

    expect(sendMessage).toHaveBeenCalledWith('!room:example', {
      msgtype: 'm.text',
      body: JSON.stringify(envelope),
      'm.type': envelope.type,
      'm.id': envelope.id,
      'm.sender': envelope.senderDid,
    });
  });
});
