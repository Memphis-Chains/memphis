import { z } from 'zod';

import { getFederationReadinessStatus } from '../../../federation/readiness.js';
import { getRustVaultAdapterStatus } from '../../storage/rust-vault-adapter.js';
import type { SqliteAgentPeerRepository } from '../../storage/sqlite/repositories/agent-peer-repository.js';

const peerRegistrationSchema = z.object({
  did: z.string().min(1).max(200),
  name: z.string().max(200).optional(),
  endpoint: z.string().url().max(500),
  capabilities: z.array(z.string().max(50)).max(20).optional(),
});

const peerHeartbeatSchema = z.object({
  did: z.string().min(1).max(200),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApp = any;

export function registerFederationRoutes(
  app: AnyApp,
  peerRepo?: SqliteAgentPeerRepository,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  // GET /api/federation/health — federation readiness gate
  app.get('/api/federation/health', async (_request: AnyApp, reply: AnyApp) => {
    return reply.send(getFederationReadinessStatus(rawEnv, getRustVaultAdapterStatus(), peerRepo));
  });

  // POST /api/federation/peers/register — register or update a peer agent
  app.post('/api/federation/peers/register', async (request: AnyApp, reply: AnyApp) => {
    if (!peerRepo) {
      return reply.status(503).send({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Peer storage not initialized' },
      });
    }

    const parsed = peerRegistrationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      });
    }

    const { did, name, endpoint, capabilities } = parsed.data;
    const peer = peerRepo.upsert(did, endpoint, capabilities ?? [], name);

    return reply.send({ ok: true, peer });
  });

  // POST /api/federation/peers/heartbeat — update peer presence
  app.post('/api/federation/peers/heartbeat', async (request: AnyApp, reply: AnyApp) => {
    if (!peerRepo) {
      return reply.status(503).send({
        error: { code: 'SERVICE_UNAVAILABLE', message: 'Peer storage not initialized' },
      });
    }

    const parsed = peerHeartbeatSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: parsed.error.issues.map((i) => i.message).join('; '),
        },
      });
    }

    const peer = peerRepo.getByDid(parsed.data.did);
    if (!peer) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `Peer ${parsed.data.did} not registered` },
      });
    }

    peerRepo.updateStatus(parsed.data.did, 'online');
    return reply.send({ ok: true, did: parsed.data.did, status: 'online' });
  });

  // GET /api/federation/peers — list known peer agents
  app.get('/api/federation/peers', async (request: AnyApp, reply: AnyApp) => {
    if (!peerRepo) {
      return reply.send({ peers: [], count: 0 });
    }

    const status = (request.query as Record<string, string | undefined>).status;
    const validStatuses = ['online', 'offline', 'unknown'] as const;
    const filteredStatus =
      status && validStatuses.includes(status as (typeof validStatuses)[number])
        ? (status as (typeof validStatuses)[number])
        : undefined;

    const peers = peerRepo.list(filteredStatus);
    return reply.send({ peers, count: peers.length });
  });
}
