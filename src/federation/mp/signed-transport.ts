/**
 * SignedMatrixTransport — MP v0 wrapper around any SyncTransport.
 *
 * Responsibilities:
 *   - On send: sign the envelope with the operator's MP v0 seed, write
 *     an outbound block to `messages.chain`, then delegate to the inner
 *     transport.
 *   - On receive: verify the envelope, optionally check the signer is in
 *     the agent_peers trust store, audit any rejection to `decisions`,
 *     write the verified envelope to `messages.chain`, and only then
 *     forward to user-registered handlers.
 *
 * The wrapper composes — it does not subclass MatrixTransport. The same
 * wrapper applies to WebSocketTransport in H2 with zero changes.
 *
 * Audit failures (chain write throws) are swallowed so transport
 * loops never stall on a degraded chain backend; a separate
 * security-audit channel records the failure via writeSecurityAudit.
 */

import { parseBool } from '../../core/env.js';
import { writeSecurityAudit } from '../../infra/logging/security-audit.js';
import { appendBlock } from '../../infra/storage/chain-adapter.js';
import type { SqliteAgentPeerRepository } from '../../infra/storage/sqlite/repositories/agent-peer-repository.js';
import type { SyncEnvelope } from '../../sync/protocol.js';
import type { SyncTransport } from '../../sync/transport.js';
import type { FederationTrustMode } from '../readiness.js';
import {
  signEnvelope,
  verifyEnvelope,
  type SignedSyncEnvelope,
  type VerifyEnvelopeFailureReason,
} from './envelope.js';

export type MpV0RejectReason =
  | VerifyEnvelopeFailureReason
  | 'unknown_peer'
  | 'replay_detected';

export type SignedMatrixTransportDeps = {
  inner: SyncTransport;
  /** Buffer is intentionally kept around — see Risks #3 in the plan. */
  signingSeed: Buffer;
  /** Operator's MP v0 DID, derived from signingSeed at construction. */
  signerDid: string;
  peerRepo: SqliteAgentPeerRepository;
  trustMode: FederationTrustMode;
  /** Default true. When false, unsigned envelopes accepted with warning audit. */
  requireSigned: boolean;
  matrixRoomId: string;
  /** Injectable for tests. */
  appendBlockFn?: typeof appendBlock;
  rawEnv?: NodeJS.ProcessEnv;
  now?: () => Date;
};

export type BuildSignedMatrixTransportOptions = Omit<
  SignedMatrixTransportDeps,
  'requireSigned' | 'appendBlockFn' | 'rawEnv' | 'now'
> & {
  requireSigned?: boolean;
  appendBlockFn?: typeof appendBlock;
  rawEnv?: NodeJS.ProcessEnv;
  now?: () => Date;
};

const SECURITY_AUDIT_AUDIT_FAILURE = 'mp.v0.audit_write_failed';

export class SignedMatrixTransport implements SyncTransport {
  private readonly handlers: Array<(envelope: SyncEnvelope) => void> = [];
  private readonly deps: Required<
    Pick<SignedMatrixTransportDeps, 'appendBlockFn' | 'rawEnv' | 'now'>
  > &
    SignedMatrixTransportDeps;
  private innerHandlerRegistered = false;

  constructor(deps: SignedMatrixTransportDeps) {
    this.deps = {
      ...deps,
      appendBlockFn: deps.appendBlockFn ?? appendBlock,
      rawEnv: deps.rawEnv ?? process.env,
      now: deps.now ?? (() => new Date()),
    };
  }

  async connect(): Promise<void> {
    if (this.deps.inner.connect) await this.deps.inner.connect();
  }

  async send(envelope: SyncEnvelope): Promise<void> {
    // The caller may have set senderDid to whatever; we always overwrite
    // with the seed-derived DID so on-the-wire data is authoritative
    // against the secret, not env metadata. signEnvelope enforces this.
    const outgoing: SyncEnvelope = { ...envelope, senderDid: this.deps.signerDid };
    const signed = signEnvelope(outgoing, this.deps.signingSeed);

    // Write outbound BEFORE the network call so the local chain reflects
    // intent even if Matrix delivery later fails. A failed inner.send
    // appends a separate `mp_v0.envelope_send_failed` audit block.
    await this.safeAppendMessages('mp_v0.envelope_sent', {
      envelope: signed,
      direction: 'outbound',
      matrixRoomId: this.deps.matrixRoomId,
    });

    try {
      await this.deps.inner.send(signed);
    } catch (err) {
      await this.safeAppendDecisions('mp_v0.envelope_send_failed', {
        reason: 'inner_transport_error',
        envelopeId: signed.id,
        senderDid: signed.senderDid,
        signerDid: signed.signerDid,
        type: signed.type,
        matrixRoomId: this.deps.matrixRoomId,
        direction: 'outbound',
        detail: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  onMessage(handler: (envelope: SyncEnvelope) => void): void {
    this.handlers.push(handler);
    if (this.innerHandlerRegistered) return;
    this.innerHandlerRegistered = true;
    this.deps.inner.onMessage((rawEnvelope) => {
      void this.handleInbound(rawEnvelope);
    });
  }

  close(): void {
    this.deps.inner.close();
    this.handlers.length = 0;
  }

  private async handleInbound(rawEnvelope: SyncEnvelope): Promise<void> {
    const verifyResult = verifyEnvelope(rawEnvelope);

    // Branch 1: envelope arrived unsigned. Two policies based on
    // requireSigned. Either way, never deliver to handlers without an
    // audit so the operator can review.
    if (!verifyResult.valid && verifyResult.reason === 'unsigned_rejected') {
      if (this.deps.requireSigned) {
        await this.rejectInbound('unsigned_rejected', rawEnvelope, null);
        return;
      }
      // Backwards-compat path: accept with warning. Useful for pilot
      // bootstrap when one peer hasn't enabled MP v0 yet. We still write
      // to messages.chain but mark verifiedSigner null so downstream
      // consumers can filter unsigned blocks if they want.
      await this.safeAppendMessages('mp_v0.envelope_received', {
        envelope: rawEnvelope,
        direction: 'inbound',
        matrixRoomId: this.deps.matrixRoomId,
        receivedAt: this.deps.now().toISOString(),
        verifiedSigner: null,
        warning: 'unsigned_accepted',
      });
      this.dispatch(rawEnvelope);
      return;
    }

    if (!verifyResult.valid) {
      await this.rejectInbound(verifyResult.reason, rawEnvelope, verifyResult.signerDid);
      return;
    }

    const { signerDid, envelope: verifiedEnvelope } = verifyResult;

    // Trust check — under trusted-pilot mode, unknown DIDs are rejected.
    // Under public-deferred mode, log warning but accept.
    const trusted = this.deps.peerRepo.isTrusted(signerDid);
    if (!trusted) {
      if (this.deps.trustMode === 'trusted-pilot') {
        await this.rejectInbound('unknown_peer', rawEnvelope, signerDid);
        return;
      }
      writeSecurityAudit({
        action: 'mp.v0.unknown_peer_accepted',
        status: 'allowed',
        details: {
          trustMode: this.deps.trustMode,
          signerDid,
          envelopeId: verifiedEnvelope.id,
          matrixRoomId: this.deps.matrixRoomId,
        },
      });
    }

    // Successful verify path. Write to messages chain, mark seen, dispatch.
    await this.safeAppendMessages('mp_v0.envelope_received', {
      envelope: verifiedEnvelope as SignedSyncEnvelope,
      direction: 'inbound',
      matrixRoomId: this.deps.matrixRoomId,
      receivedAt: this.deps.now().toISOString(),
      verifiedSigner: signerDid,
    });

    if (trusted) {
      try {
        this.deps.peerRepo.markSeen(signerDid);
      } catch {
        // markSeen failure is non-critical; the verify already passed.
      }
    }

    this.dispatch(verifiedEnvelope);
  }

  private dispatch(envelope: SyncEnvelope): void {
    for (const h of this.handlers) {
      try {
        h(envelope);
      } catch {
        // Handler errors are the user's responsibility, not the transport's.
      }
    }
  }

  private async rejectInbound(
    reason: MpV0RejectReason,
    rawEnvelope: SyncEnvelope | null,
    signerDid: string | null,
  ): Promise<void> {
    await this.safeAppendDecisions('mp_v0.envelope_rejected', {
      reason,
      envelopeId: rawEnvelope?.id ?? null,
      senderDid: rawEnvelope?.senderDid ?? null,
      signerDid,
      type: rawEnvelope?.type ?? null,
      matrixRoomId: this.deps.matrixRoomId,
      direction: 'inbound',
      receivedAt: this.deps.now().toISOString(),
    });
  }

  private async safeAppendMessages(
    type: 'mp_v0.envelope_sent' | 'mp_v0.envelope_received',
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.appendBlockFn(
        'messages',
        { type, schemaVersion: 1, source: 'mp.v0', payload },
        this.deps.rawEnv,
      );
    } catch (err) {
      writeSecurityAudit({
        action: SECURITY_AUDIT_AUDIT_FAILURE,
        status: 'error',
        details: {
          chain: 'messages',
          type,
          detail: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  private async safeAppendDecisions(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.deps.appendBlockFn(
        'decisions',
        { type, schemaVersion: 1, source: 'mp.v0', payload },
        this.deps.rawEnv,
      );
    } catch (err) {
      writeSecurityAudit({
        action: SECURITY_AUDIT_AUDIT_FAILURE,
        status: 'error',
        details: {
          chain: 'decisions',
          type,
          detail: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }
}

/**
 * Standard factory — reads MP_V0_REQUIRE_SIGNED off the env (default true)
 * and constructs a SignedMatrixTransport. Use this in production wiring;
 * pass an override `requireSigned` only in tests or migration scripts.
 */
export function buildSignedMatrixTransport(
  options: BuildSignedMatrixTransportOptions,
): SignedMatrixTransport {
  const rawEnv = options.rawEnv ?? process.env;
  const requireSigned =
    options.requireSigned ?? parseBool(rawEnv.MP_V0_REQUIRE_SIGNED, true);
  return new SignedMatrixTransport({
    inner: options.inner,
    signingSeed: options.signingSeed,
    signerDid: options.signerDid,
    peerRepo: options.peerRepo,
    trustMode: options.trustMode,
    requireSigned,
    matrixRoomId: options.matrixRoomId,
    appendBlockFn: options.appendBlockFn,
    rawEnv,
    now: options.now,
  });
}
