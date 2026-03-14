import { beforeAll, describe, expect, it, vi } from 'vitest';

import { AgentCoordinator, ModelD_CollectiveCoordination } from '../../src/cognitive/model-d.js';
import type { AgentConfig } from '../../src/cognitive/types.js';

const agents: AgentConfig[] = [
  { id: 'memphis', name: 'Memphis', endpoint: 'local', publicKey: 'pk1', weight: 1 },
  { id: 'watra', name: 'Watra', endpoint: 'local', publicKey: 'pk2', weight: 2 },
  { id: 'atlas', name: 'Atlas', endpoint: 'local', publicKey: 'pk3', weight: 1 },
];

beforeAll(() => {
  (
    ModelD_CollectiveCoordination as unknown as {
      prototype: { persistEvent?: (...args: unknown[]) => Promise<void> };
    }
  ).prototype.persistEvent = async () => {};
});

const createModel = () =>
  new ModelD_CollectiveCoordination({
    consensusThreshold: 0.6,
    votingTimeout: 5 * 60_000,
    agents,
  });

describe('Model D — comprehensive', () => {
  it('creates proposal in voting state', () => {
    const model = createModel();
    const proposal = model.propose(
      'Adopt new protocol',
      'Move to protocol v2',
      'memphis',
      'strategic',
    );

    expect(proposal.status).toBe('voting');
    expect(proposal.votes).toHaveLength(0);
    expect(model.getActiveProposals()).toHaveLength(1);
  });

  it('records votes with signatures', () => {
    const model = createModel();
    const proposal = model.propose('Ship feature', 'Release this sprint', 'memphis');

    const vote = model.vote(proposal.id, 'watra', 'approve', 'looks good');

    expect(vote.signature).toHaveLength(64);
    expect(model.verifyVote(vote, proposal.id)).toBe(true);
  });

  it('prevents duplicate voting by same agent', () => {
    const model = createModel();
    const proposal = model.propose('Ship feature', 'Release this sprint', 'memphis');

    model.vote(proposal.id, 'watra', 'approve');

    expect(() => model.vote(proposal.id, 'watra', 'reject')).toThrow(/already voted/);
  });

  it('rejects unknown agents', () => {
    const model = createModel();
    const proposal = model.propose('Ship feature', 'Release this sprint', 'memphis');

    expect(() => model.vote(proposal.id, 'ghost', 'approve')).toThrow(/not registered/);
  });

  it('auto-closes voting on majority approvals', () => {
    const model = createModel();
    const proposal = model.propose('Infra hardening', 'Enable hardening', 'memphis');

    model.vote(proposal.id, 'memphis', 'approve');
    model.vote(proposal.id, 'watra', 'approve');

    const updated = model.getProposal(proposal.id)!;
    expect(updated.status).toBe('approved');
    expect(updated.result?.approved).toBe(true);
  });

  it('calculates weighted score correctly', () => {
    const model = createModel();
    const proposal = model.propose('Selective rollout', 'Canary deploy', 'memphis');

    model.vote(proposal.id, 'memphis', 'approve'); // 1
    model.vote(proposal.id, 'watra', 'reject'); // 2
    model.vote(proposal.id, 'atlas', 'approve'); // 1

    const result = model.closeVoting(proposal.id);
    expect(result.weightedScore).toBeCloseTo(0.5, 5); // (1+1)/(1+2+1)
    expect(result.approved).toBe(false);
  });

  it('can execute only approved proposals', () => {
    const model = createModel();
    const proposal = model.propose('Routine ops', 'Do maintenance', 'memphis');

    model.vote(proposal.id, 'memphis', 'approve');
    model.vote(proposal.id, 'watra', 'approve');

    model.execute(proposal.id, 'atlas');
    const executed = model.getProposal(proposal.id)!;

    expect(executed.status).toBe('executed');
    expect(executed.result?.executedBy).toBe('atlas');
  });

  it('toBlock exports collective decision details', () => {
    const model = createModel();
    const proposal = model.propose(
      'Enable audit logs',
      'Track all decisions',
      'memphis',
      'operational',
    );

    model.vote(proposal.id, 'memphis', 'approve');
    model.vote(proposal.id, 'watra', 'approve');

    const block = model.toBlock(proposal.id);

    expect(block.chain).toBe('decision');
    expect(block.data?.type).toBe('decision');
    expect(block.data?.collectiveDecision).toBeDefined();
  });

  it('returns agent voting statistics', () => {
    const model = createModel();
    const p1 = model.propose('P1', 'desc', 'memphis');
    const p2 = model.propose('P2', 'desc', 'memphis');

    model.vote(p1.id, 'watra', 'approve');
    model.vote(p2.id, 'watra', 'abstain');

    const stats = model.getAgentStats('watra');
    expect(stats.proposalsVoted).toBe(2);
    expect(stats.approvals).toBe(1);
    expect(stats.abstentions).toBe(1);
  });

  it('AgentCoordinator proposes/votes and exposes stats', async () => {
    const coordinator = new AgentCoordinator(agents[0], [agents[1], agents[2]], 0.6);
    const proposal = await coordinator.proposeToNetwork(
      'Optimize tests',
      'Run full suite',
      'tactical',
    );

    await coordinator.voteOnProposal(proposal.id, 'approve', 'good');
    const stats = coordinator.getStats();

    expect(stats.localAgent).toBe('Memphis');
    expect(stats.remoteAgents).toBe(2);
    expect(stats.consensusThreshold).toBe(0.6);
  });

  it('broadcasts proposals to remote HTTP endpoints and ingests returned vote', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ vote: { choice: 'approve', reason: 'aligned' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const localAgent: AgentConfig = {
      id: 'memphis',
      name: 'Memphis',
      endpoint: 'http://127.0.0.1:8787',
      publicKey: 'pk-local',
      weight: 1,
    };
    const remoteAgent: AgentConfig = {
      id: 'watra',
      name: 'Watra',
      endpoint: 'https://watra.example',
      publicKey: 'pk-remote',
      weight: 2,
    };

    const coordinator = new AgentCoordinator(localAgent, [remoteAgent], 0.6, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      broadcastPath: '/collective/proposals',
      requestTimeoutMs: 1000,
    });

    const proposal = await coordinator.proposeToNetwork(
      'Remote vote',
      'Broadcast test',
      'tactical',
    );
    const broadcasts = coordinator.getLastBroadcastResults();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://watra.example/collective/proposals',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(broadcasts[0]?.ok).toBe(true);
    expect(broadcasts[0]?.vote?.choice).toBe('approve');
    expect(proposal.votes.some((v) => v.agentId === 'watra' && v.choice === 'approve')).toBe(true);
  });
});
