import { randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testing,
  didMemphisFromPubkey,
  signEnvelope,
  type SignedSyncEnvelope,
} from '../../src/federation/mp/envelope.js';
import { SignedMatrixTransport } from '../../src/federation/mp/signed-transport.js';
import type { SqliteAgentPeerRepository } from '../../src/infra/storage/sqlite/repositories/agent-peer-repository.js';
import type { SyncEnvelope } from '../../src/sync/protocol.js';
import type { SyncTransport } from '../../src/sync/transport.js';

class MockTransport implements SyncTransport {
  public readonly sent: SyncEnvelope[] = [];
  public readonly handlers: Array<(env: SyncEnvelope) => void> = [];
  public closed = false;
  public sendShouldFail = false;

  async send(envelope: SyncEnvelope): Promise<void> {
    if (this.sendShouldFail) throw new Error('mock send failed');
    this.sent.push(envelope);
  }

  onMessage(handler: (env: SyncEnvelope) => void): void {
    this.handlers.push(handler);
  }

  close(): void {
    this.closed = true;
  }

  receive(env: SyncEnvelope): void {
    for (const h of this.handlers) h(env);
  }
}

function makePeerRepo(trustedDids: string[]): SqliteAgentPeerRepository {
  const trusted = new Set(trustedDids);
  const seen: string[] = [];
  const fake = {
    isTrusted: (did: string) => trusted.has(did),
    markSeen: (did: string) => seen.push(did),
    seenList: seen,
  };
  return fake as unknown as SqliteAgentPeerRepository & { seenList: string[] };
}

function freshIdentity(): { seed: Buffer; did: string } {
  const seed = randomBytes(32);
  const did = didMemphisFromPubkey(__testing.pubkeyFromSeed(seed));
  return { seed, did };
}

type RecordedAppend = { chain: string; data: Record<string, unknown> };

function makeAppendRecorder() {
  const calls: RecordedAppend[] = [];
  const fn = vi.fn(async (chain: string, data: Record<string, unknown>) => {
    calls.push({ chain, data });
    return { index: calls.length, hash: 'fakehash', chain, timestamp: '2026-04-25T22:00:00Z' };
  });
  return { calls, fn: fn as unknown as typeof import('../../src/infra/storage/chain-adapter.js').appendBlock };
}

function baseEnvelope(senderDid: string, payload: unknown = { ok: true }): SyncEnvelope {
  return {
    id: `env-${Math.random().toString(36).slice(2, 10)}`,
    type: 'sync.status',
    senderDid,
    ts: '2026-04-25T22:00:00.000Z',
    payload,
  };
}

describe('SignedMatrixTransport: send', () => {
  let local: ReturnType<typeof freshIdentity>;
  let inner: MockTransport;
  let recorder: ReturnType<typeof makeAppendRecorder>;
  let transport: SignedMatrixTransport;

  beforeEach(() => {
    local = freshIdentity();
    inner = new MockTransport();
    recorder = makeAppendRecorder();
    transport = new SignedMatrixTransport({
      inner,
      signingSeed: local.seed,
      signerDid: local.did,
      peerRepo: makePeerRepo([]),
      trustMode: 'trusted-pilot',
      requireSigned: true,
      matrixRoomId: '!room:matrix.local',
      appendBlockFn: recorder.fn,
    });
  });

  it('signs the envelope and writes outbound block before delegating', async () => {
    await transport.send(baseEnvelope('did:bogus:placeholder', { hello: 'world' }));

    expect(recorder.calls).toHaveLength(1);
    expect(recorder.calls[0].chain).toBe('messages');
    const data = recorder.calls[0].data;
    expect(data.type).toBe('mp_v0.envelope_sent');
    expect(data.source).toBe('mp.v0');
    expect((data.payload as Record<string, unknown>).direction).toBe('outbound');

    expect(inner.sent).toHaveLength(1);
    const sent = inner.sent[0] as SignedSyncEnvelope;
    expect(sent.signature).toBeDefined();
    expect(sent.signerDid).toBe(local.did);
    expect(sent.senderDid).toBe(local.did); // overwritten from caller bogus
  });

  it('records a send failure decision and rethrows', async () => {
    inner.sendShouldFail = true;
    await expect(transport.send(baseEnvelope(local.did))).rejects.toThrow(/mock send failed/);

    const decisionCalls = recorder.calls.filter((c) => c.chain === 'decisions');
    expect(decisionCalls).toHaveLength(1);
    expect(decisionCalls[0].data.type).toBe('mp_v0.envelope_send_failed');
  });
});

describe('SignedMatrixTransport: receive', () => {
  let local: ReturnType<typeof freshIdentity>;
  let peer: ReturnType<typeof freshIdentity>;
  let inner: MockTransport;
  let recorder: ReturnType<typeof makeAppendRecorder>;
  let received: SyncEnvelope[] = [];

  beforeEach(() => {
    local = freshIdentity();
    peer = freshIdentity();
    inner = new MockTransport();
    recorder = makeAppendRecorder();
    received = [];
  });

  function buildLocal(opts: {
    trustedPeers?: string[];
    requireSigned?: boolean;
    trustMode?: 'trusted-pilot' | 'public-deferred';
  } = {}) {
    const transport = new SignedMatrixTransport({
      inner,
      signingSeed: local.seed,
      signerDid: local.did,
      peerRepo: makePeerRepo(opts.trustedPeers ?? [peer.did]),
      trustMode: opts.trustMode ?? 'trusted-pilot',
      requireSigned: opts.requireSigned ?? true,
      matrixRoomId: '!room:matrix.local',
      appendBlockFn: recorder.fn,
    });
    transport.onMessage((env) => received.push(env));
    return transport;
  }

  it('delivers a valid envelope from a trusted peer and writes inbound block', async () => {
    buildLocal();
    const signed = signEnvelope(baseEnvelope(peer.did), peer.seed);
    inner.receive(signed);
    // handlers run synchronously; allow any pending micro-tasks to flush
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(1);
    const inbound = recorder.calls.find(
      (c) => c.chain === 'messages' && c.data.type === 'mp_v0.envelope_received',
    );
    expect(inbound).toBeDefined();
    const payload = (inbound!.data as Record<string, unknown>).payload as Record<string, unknown>;
    expect(payload.direction).toBe('inbound');
    expect(payload.verifiedSigner).toBe(peer.did);
    expect(recorder.calls.find((c) => c.chain === 'decisions')).toBeUndefined();
  });

  it('rejects envelope from unknown peer under trusted-pilot mode', async () => {
    buildLocal({ trustedPeers: [] });
    const signed = signEnvelope(baseEnvelope(peer.did), peer.seed);
    inner.receive(signed);
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(0);
    const reject = recorder.calls.find(
      (c) => c.chain === 'decisions' && c.data.type === 'mp_v0.envelope_rejected',
    );
    expect(reject).toBeDefined();
    expect((reject!.data.payload as Record<string, unknown>).reason).toBe('unknown_peer');
  });

  it('accepts unknown peer under public-deferred mode (with audit warning)', async () => {
    buildLocal({ trustedPeers: [], trustMode: 'public-deferred' });
    const signed = signEnvelope(baseEnvelope(peer.did), peer.seed);
    inner.receive(signed);
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(1);
  });

  it('rejects tampered signature with signature_invalid', async () => {
    buildLocal();
    const signed = signEnvelope(baseEnvelope(peer.did), peer.seed);
    const tampered: SignedSyncEnvelope = { ...signed, payload: { tampered: true } };
    inner.receive(tampered);
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(0);
    const reject = recorder.calls.find(
      (c) => c.chain === 'decisions' && c.data.type === 'mp_v0.envelope_rejected',
    );
    expect((reject!.data.payload as Record<string, unknown>).reason).toBe('signature_invalid');
  });

  it('rejects unsigned envelope when requireSigned=true (default)', async () => {
    buildLocal();
    const unsigned = baseEnvelope(peer.did);
    inner.receive(unsigned);
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(0);
    const reject = recorder.calls.find(
      (c) => c.chain === 'decisions' && c.data.type === 'mp_v0.envelope_rejected',
    );
    expect((reject!.data.payload as Record<string, unknown>).reason).toBe('unsigned_rejected');
  });

  it('accepts unsigned envelope with warning when requireSigned=false', async () => {
    buildLocal({ requireSigned: false });
    const unsigned = baseEnvelope(peer.did);
    inner.receive(unsigned);
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(1);
    const inbound = recorder.calls.find(
      (c) => c.chain === 'messages' && c.data.type === 'mp_v0.envelope_received',
    );
    const payload = (inbound!.data as Record<string, unknown>).payload as Record<string, unknown>;
    expect(payload.warning).toBe('unsigned_accepted');
    expect(payload.verifiedSigner).toBeNull();
  });

  it('rejects sender_signer_mismatch when senderDid is hand-edited post-sign', async () => {
    buildLocal();
    const other = freshIdentity();
    const signed = signEnvelope(baseEnvelope(peer.did), peer.seed);
    const muted: SignedSyncEnvelope = { ...signed, senderDid: other.did };
    inner.receive(muted);
    await new Promise((r) => setImmediate(r));

    expect(received).toHaveLength(0);
    const reject = recorder.calls.find(
      (c) => c.chain === 'decisions' && c.data.type === 'mp_v0.envelope_rejected',
    );
    expect((reject!.data.payload as Record<string, unknown>).reason).toBe(
      'sender_signer_mismatch',
    );
  });

  it('audit-write failure does not crash the receive loop', async () => {
    const failing = vi.fn(async () => {
      throw new Error('chain backend down');
    }) as unknown as typeof import('../../src/infra/storage/chain-adapter.js').appendBlock;
    const transport = new SignedMatrixTransport({
      inner,
      signingSeed: local.seed,
      signerDid: local.did,
      peerRepo: makePeerRepo([peer.did]),
      trustMode: 'trusted-pilot',
      requireSigned: true,
      matrixRoomId: '!room:matrix.local',
      appendBlockFn: failing,
    });
    transport.onMessage((env) => received.push(env));

    const signed = signEnvelope(baseEnvelope(peer.did), peer.seed);
    expect(() => inner.receive(signed)).not.toThrow();
    await new Promise((r) => setImmediate(r));
    // Handler still gets called even when audit fails — verify already passed.
    expect(received).toHaveLength(1);
  });
});
