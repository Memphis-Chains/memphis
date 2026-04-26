/**
 * MP v0 federation end-to-end — two-instance signed handshake.
 *
 * Stands up two `SignedMatrixTransport` instances that share an
 * in-memory Matrix room. Each side has its own seed, DID, and peer
 * registry. We verify that:
 *   - A signed envelope from Alice arrives at Bob and is forwarded to
 *     Bob's handler with the verified payload intact.
 *   - Both sides' simulated `messages.chain` records the exchange with
 *     matching envelope ids and signatures.
 *   - When Alice signs with a key Bob hasn't registered, Bob writes a
 *     `mp_v0.envelope_rejected` audit and never delivers the envelope
 *     to handlers.
 */

import { randomBytes } from 'node:crypto';

import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import {
  __testing,
  didMemphisFromPubkey,
} from '../../src/federation/mp/envelope.js';
import {
  buildSignedMatrixTransport,
  type SignedMatrixTransport,
} from '../../src/federation/mp/signed-transport.js';
import { SqliteAgentPeerRepository } from '../../src/infra/storage/sqlite/repositories/agent-peer-repository.js';
import type { SyncEnvelope } from '../../src/sync/protocol.js';
import type { SyncTransport } from '../../src/sync/transport.js';

/**
 * In-memory Matrix bridge — every send to side A is mirrored to side B
 * (and vice versa) with no Matrix homeserver involved. We model the
 * inner SyncTransport directly because MatrixTransport's polling loop
 * needs a real client; this transport is functionally equivalent for
 * the wrapper layer.
 */
class InMemoryRelayTransport implements SyncTransport {
  private peer: InMemoryRelayTransport | null = null;
  private handlers: Array<(env: SyncEnvelope) => void> = [];
  public readonly outbound: SyncEnvelope[] = [];

  link(peer: InMemoryRelayTransport): void {
    this.peer = peer;
  }

  async send(envelope: SyncEnvelope): Promise<void> {
    this.outbound.push(envelope);
    if (!this.peer) return;
    // Round-trip through JSON to mirror the Matrix wire encoding fidelity.
    const wire = JSON.parse(JSON.stringify(envelope)) as SyncEnvelope;
    for (const h of this.peer.handlers) h(wire);
  }

  onMessage(handler: (env: SyncEnvelope) => void): void {
    this.handlers.push(handler);
  }

  close(): void {
    this.handlers = [];
    this.peer = null;
  }
}

function createPeerRepo(): SqliteAgentPeerRepository {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_peers (
      did TEXT PRIMARY KEY,
      name TEXT,
      endpoint TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'unknown',
      last_seen_at TEXT,
      registered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return new SqliteAgentPeerRepository(db);
}

function freshIdentity(): { seed: Buffer; did: string } {
  const seed = randomBytes(32);
  const did = didMemphisFromPubkey(__testing.pubkeyFromSeed(seed));
  return { seed, did };
}

type RecordedAppend = { chain: string; data: Record<string, unknown> };

function makeAppendRecorder() {
  const calls: RecordedAppend[] = [];
  let counter = 0;
  const fn = vi.fn(async (chain: string, data: Record<string, unknown>) => {
    counter += 1;
    calls.push({ chain, data });
    return {
      index: counter,
      hash: `fakehash-${counter}`,
      chain,
      timestamp: '2026-04-25T22:00:00Z',
    };
  });
  return {
    calls,
    fn: fn as unknown as typeof import('../../src/infra/storage/chain-adapter.js').appendBlock,
  };
}

function buildPair(opts: { trustEachOther: boolean }): {
  alice: ReturnType<typeof freshIdentity> & {
    transport: SignedMatrixTransport;
    received: SyncEnvelope[];
    chainCalls: RecordedAppend[];
    inner: InMemoryRelayTransport;
  };
  bob: ReturnType<typeof freshIdentity> & {
    transport: SignedMatrixTransport;
    received: SyncEnvelope[];
    chainCalls: RecordedAppend[];
    inner: InMemoryRelayTransport;
  };
} {
  const aliceId = freshIdentity();
  const bobId = freshIdentity();

  const aliceInner = new InMemoryRelayTransport();
  const bobInner = new InMemoryRelayTransport();
  aliceInner.link(bobInner);
  bobInner.link(aliceInner);

  const alicePeers = createPeerRepo();
  const bobPeers = createPeerRepo();

  if (opts.trustEachOther) {
    alicePeers.upsert(bobId.did, 'matrix://bob', ['mp.v0']);
    bobPeers.upsert(aliceId.did, 'matrix://alice', ['mp.v0']);
  }

  const aliceRecorder = makeAppendRecorder();
  const bobRecorder = makeAppendRecorder();

  const aliceTransport = buildSignedMatrixTransport({
    inner: aliceInner,
    signingSeed: aliceId.seed,
    signerDid: aliceId.did,
    peerRepo: alicePeers,
    trustMode: 'trusted-pilot',
    matrixRoomId: '!shared:matrix.local',
    appendBlockFn: aliceRecorder.fn,
  });
  const bobTransport = buildSignedMatrixTransport({
    inner: bobInner,
    signingSeed: bobId.seed,
    signerDid: bobId.did,
    peerRepo: bobPeers,
    trustMode: 'trusted-pilot',
    matrixRoomId: '!shared:matrix.local',
    appendBlockFn: bobRecorder.fn,
  });

  const aliceReceived: SyncEnvelope[] = [];
  const bobReceived: SyncEnvelope[] = [];
  aliceTransport.onMessage((e) => aliceReceived.push(e));
  bobTransport.onMessage((e) => bobReceived.push(e));

  return {
    alice: {
      ...aliceId,
      transport: aliceTransport,
      received: aliceReceived,
      chainCalls: aliceRecorder.calls,
      inner: aliceInner,
    },
    bob: {
      ...bobId,
      transport: bobTransport,
      received: bobReceived,
      chainCalls: bobRecorder.calls,
      inner: bobInner,
    },
  };
}

describe('MP v0 e2e: two-instance signed handshake', () => {
  it('Alice -> Bob: signed envelope arrives, both chains record matching blocks', async () => {
    const { alice, bob } = buildPair({ trustEachOther: true });

    const env: SyncEnvelope = {
      id: 'env-handshake-1',
      type: 'sync.status',
      senderDid: alice.did,
      ts: '2026-04-25T22:00:00.000Z',
      payload: { chains: [{ name: 'journal', blocks: 42 }] },
    };
    await alice.transport.send(env);
    await new Promise((r) => setImmediate(r));

    expect(bob.received).toHaveLength(1);
    expect(bob.received[0].id).toBe('env-handshake-1');
    expect(bob.received[0].senderDid).toBe(alice.did);

    const aliceOutbound = alice.chainCalls.find(
      (c) => c.chain === 'messages' && c.data.type === 'mp_v0.envelope_sent',
    );
    expect(aliceOutbound).toBeDefined();
    const aliceEnvelope = (aliceOutbound!.data.payload as Record<string, unknown>)
      .envelope as Record<string, unknown>;
    expect(aliceEnvelope.signature).toBeDefined();

    const bobInbound = bob.chainCalls.find(
      (c) => c.chain === 'messages' && c.data.type === 'mp_v0.envelope_received',
    );
    expect(bobInbound).toBeDefined();
    const bobPayload = bobInbound!.data.payload as Record<string, unknown>;
    expect(bobPayload.verifiedSigner).toBe(alice.did);
    const bobEnvelope = bobPayload.envelope as Record<string, unknown>;
    expect(bobEnvelope.id).toBe('env-handshake-1');
    expect(bobEnvelope.signature).toBe(aliceEnvelope.signature);

    expect(bob.chainCalls.find((c) => c.chain === 'decisions')).toBeUndefined();
    expect(alice.chainCalls.find((c) => c.chain === 'decisions')).toBeUndefined();
  });

  it('Alice (unknown to Bob) -> rejected at Bob with unknown_peer audit', async () => {
    const { alice, bob } = buildPair({ trustEachOther: false });

    const env: SyncEnvelope = {
      id: 'env-rogue-1',
      type: 'sync.status',
      senderDid: alice.did,
      ts: '2026-04-25T22:00:00.000Z',
      payload: { ok: true },
    };
    await alice.transport.send(env);
    await new Promise((r) => setImmediate(r));

    expect(bob.received).toHaveLength(0);

    const reject = bob.chainCalls.find(
      (c) => c.chain === 'decisions' && c.data.type === 'mp_v0.envelope_rejected',
    );
    expect(reject).toBeDefined();
    const payload = reject!.data.payload as Record<string, unknown>;
    expect(payload.reason).toBe('unknown_peer');
    expect(payload.signerDid).toBe(alice.did);

    expect(
      bob.chainCalls.find((c) => c.chain === 'messages' && c.data.type === 'mp_v0.envelope_received'),
    ).toBeUndefined();
  });

  it('round-trip both ways: Bob acks Alice, both chains see four blocks total', async () => {
    const { alice, bob } = buildPair({ trustEachOther: true });

    await alice.transport.send({
      id: 'env-ping',
      type: 'sync.hello',
      senderDid: alice.did,
      ts: '2026-04-25T22:00:00.000Z',
      payload: { hello: 'bob' },
    });
    await new Promise((r) => setImmediate(r));

    await bob.transport.send({
      id: 'env-pong',
      type: 'sync.ack',
      senderDid: bob.did,
      ts: '2026-04-25T22:00:01.000Z',
      payload: { ack: 'env-ping' },
    });
    await new Promise((r) => setImmediate(r));

    expect(alice.received).toHaveLength(1);
    expect(bob.received).toHaveLength(1);
    expect(alice.received[0].id).toBe('env-pong');
    expect(bob.received[0].id).toBe('env-ping');

    const aliceMsg = alice.chainCalls.filter((c) => c.chain === 'messages');
    const bobMsg = bob.chainCalls.filter((c) => c.chain === 'messages');
    // Each side: 1 outbound + 1 inbound = 2 blocks per side.
    expect(aliceMsg).toHaveLength(2);
    expect(bobMsg).toHaveLength(2);
  });
});
