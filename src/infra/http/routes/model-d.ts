/* eslint-disable no-restricted-syntax -- Model-D identity and persistence use the active runtime environment */
import type { FastifyInstance } from 'fastify';

import { modelDProposalSchema } from '../../config/request-schemas.js';
import { metrics } from '../../logging/metrics.js';
import { writeSecurityAudit } from '../../logging/security-audit.js';
import type { SeenProposalRepository } from '../../storage/sqlite/repositories/seen-proposal-repository.js';

type ModelDProposalDecisionInput = {
  title: string;
  description: string;
  type: 'strategic' | 'tactical' | 'operational';
  status: 'pending' | 'voting' | 'approved' | 'rejected' | 'executed';
};

type ModelDVoteChoice = 'approve' | 'reject' | 'abstain';

type ModelDVote = {
  choice: ModelDVoteChoice;
  reason: string;
};

const MODEL_D_APPROVE_HINTS = [
  'security',
  'secure',
  'hardening',
  'harden',
  'audit',
  'integrity',
  'stability',
  'latency',
  'benchmark',
  'coverage',
  'test',
  'verification',
  'protect',
];

const MODEL_D_REJECT_HINTS = [
  'disable auth',
  'bypass auth',
  'skip test',
  'skip tests',
  'skip audit',
  'force push',
  'delete branch protection',
  'hardcode secret',
  'plaintext secret',
  'expose key',
];

function chooseModelDVote(input: ModelDProposalDecisionInput): ModelDVote {
  const text = `${input.title} ${input.description}`.toLowerCase();
  if (input.status !== 'pending' && input.status !== 'voting') {
    return {
      choice: 'abstain',
      reason: `proposal status "${input.status}" is not open for voting`,
    };
  }

  if (MODEL_D_REJECT_HINTS.some((needle) => text.includes(needle))) {
    return {
      choice: 'reject',
      reason: 'proposal contains a high-risk operation against security policy',
    };
  }

  if (MODEL_D_APPROVE_HINTS.some((needle) => text.includes(needle))) {
    return {
      choice: 'approve',
      reason: 'proposal aligns with reliability and security priorities',
    };
  }

  if (input.type === 'operational') {
    return {
      choice: 'approve',
      reason: 'operational proposal accepted with standard trust profile',
    };
  }

  return {
    choice: 'abstain',
    reason: 'insufficient signal for an automatic vote',
  };
}

export function registerModelDProposalRoute(
  app: FastifyInstance,
  repository?: SeenProposalRepository,
): void {
  // Model D proposal dedupe window: prevents replayed proposals from creating duplicate chain entries.
  // Each proposal ID is persisted to SQLite so dedup survives restarts; duplicates get a 409 Conflict.
  const DEDUPE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
  const seenProposals = repository;
  // Fallback: in-memory Map when no SQLite repo is available (e.g. tests)
  const modelDSeenProposalsFallback = seenProposals ? null : new Map<string, number>();

  function pruneModelDDedupe(): void {
    if (seenProposals) {
      seenProposals.prune(DEDUPE_WINDOW_MS);
    } else if (modelDSeenProposalsFallback) {
      const cutoff = Date.now() - DEDUPE_WINDOW_MS;
      for (const [id, ts] of modelDSeenProposalsFallback) {
        if (ts < cutoff) modelDSeenProposalsFallback.delete(id);
      }
    }
  }

  function hasSeenProposal(proposalId: string): boolean {
    if (seenProposals) return seenProposals.has(proposalId);
    return modelDSeenProposalsFallback?.has(proposalId) ?? false;
  }

  function recordProposal(proposalId: string): void {
    if (seenProposals) {
      seenProposals.record(proposalId);
    } else {
      modelDSeenProposalsFallback?.set(proposalId, Date.now());
    }
  }

  app.post<{ Body: unknown }>('/api/model-d/proposals', async (request, reply) => {
    const parsed = modelDProposalSchema.safeParse(request.body);
    if (!parsed.success) {
      writeSecurityAudit({
        action: 'model_d.proposal.receive',
        status: 'blocked',
        ip: request.ip,
        route: '/api/model-d/proposals',
        details: { reason: 'invalid_payload' },
      });
      return reply.status(400).send({
        ok: false,
        error: 'invalid model-d proposal payload',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.map(String),
          message: issue.message,
        })),
      });
    }

    const envelope = parsed.data;
    const configuredAgentId = process.env.MEMPHIS_MODEL_D_AGENT_ID?.trim();
    if (configuredAgentId && envelope.to?.id && envelope.to.id !== configuredAgentId) {
      writeSecurityAudit({
        action: 'model_d.proposal.receive',
        status: 'blocked',
        ip: request.ip,
        route: '/api/model-d/proposals',
        details: {
          reason: 'agent_id_mismatch',
          expectedAgentId: configuredAgentId,
          targetAgentId: envelope.to.id,
        },
      });
      return reply.status(409).send({
        ok: false,
        error: 'proposal target does not match local agent id',
      });
    }

    // Replay protection: reject duplicate proposal IDs within the dedupe window
    pruneModelDDedupe();
    const proposalId = envelope.proposal.id;
    if (hasSeenProposal(proposalId)) {
      writeSecurityAudit({
        action: 'model_d.proposal.receive',
        status: 'blocked',
        ip: request.ip,
        route: '/api/model-d/proposals',
        details: { reason: 'duplicate_proposal', proposalId },
      });
      return reply.status(409).send({
        ok: false,
        error: 'duplicate proposal id — already processed within dedupe window',
        proposalId,
      });
    }
    recordProposal(proposalId);

    const proposalStart = Date.now();
    const vote = chooseModelDVote(envelope.proposal);
    writeSecurityAudit({
      action: 'model_d.proposal.receive',
      status: 'allowed',
      ip: request.ip,
      route: '/api/model-d/proposals',
      details: {
        proposalId: envelope.proposal.id,
        fromAgentId: envelope.from.id,
        vote: vote.choice,
      },
    });

    try {
      const { appendBlock } = await import('../../storage/chain-adapter.js');
      const content = `Model D proposal ${envelope.proposal.id} from ${envelope.from.id}: ${envelope.proposal.title}`;
      await appendBlock(
        'collective',
        {
          type: 'insight',
          kind: 'model-d-proposal',
          content,
          tags: ['model-d', 'collective', 'proposal', vote.choice],
          proposalId: envelope.proposal.id,
          proposalType: envelope.proposal.type,
          fromAgentId: envelope.from.id,
          targetAgentId: envelope.to?.id ?? null,
          voteChoice: vote.choice,
          voteReason: vote.reason,
        },
        process.env,
      );
    } catch (error) {
      request.log.warn(
        {
          event: 'model_d.proposal.persist_failed',
          proposalId: envelope.proposal.id,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist model-d proposal vote',
      );
    }

    metrics.recordModelDProposal(vote.choice, Date.now() - proposalStart);

    return {
      ok: true,
      protocol: envelope.protocol,
      proposalId: envelope.proposal.id,
      receiver: {
        id: configuredAgentId || 'memphis-node',
        name: process.env.MEMPHIS_MODEL_D_AGENT_NAME?.trim() || 'Memphis Node',
      },
      vote,
      receivedAt: new Date().toISOString(),
    };
  });
}
