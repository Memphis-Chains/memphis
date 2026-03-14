/**
 * Model D — Collective Coordination
 *
 * Decision protocols for multi-agent environments (Memphis ↔ Watra ↔ ...)
 * Supports voting, consensus, and collaborative decisions.
 *
 * @version 5.0.0
 * @inspired-by Memphis v3.8.2
 */

import * as crypto from 'crypto';

import { ChainStore, IStore } from './store.js';
import type { AgentConfig, DecisionContext, ModelDConfig } from './types.js';
import type { Block } from '../memory/chain.js';

// ============================================================================
// TYPES
// ============================================================================

export interface Proposal {
  id: string;
  title: string;
  description: string;
  proposer: string; // Agent ID
  type: 'strategic' | 'tactical' | 'operational';
  status: 'pending' | 'voting' | 'approved' | 'rejected' | 'executed';
  createdAt: Date;
  votingDeadline?: Date;
  votes: Vote[];
  result?: DecisionResult;
  context?: DecisionContext;
}

export interface Vote {
  agentId: string;
  choice: 'approve' | 'reject' | 'abstain';
  weight: number;
  reason?: string;
  timestamp: Date;
  signature: string; // Cryptographic signature
}

export interface DecisionResult {
  approved: boolean;
  totalVotes: number;
  approveVotes: number;
  rejectVotes: number;
  abstainVotes: number;
  weightedScore: number; // Weighted average
  consensusReached: boolean;
  executedBy?: string;
  executedAt?: Date;
}

export interface CollectiveDecision {
  proposal: Proposal;
  participants: AgentConfig[];
  quorum: number; // Minimum participation
  consensusThreshold: number; // 0.0-1.0
}

interface BroadcastVote {
  choice: 'approve' | 'reject' | 'abstain';
  reason?: string;
}

interface BroadcastResult {
  agentId: string;
  endpoint: string;
  ok: boolean;
  status?: number;
  vote?: BroadcastVote;
  error?: string;
}

export interface AgentCoordinatorOptions {
  requestTimeoutMs?: number;
  broadcastPath?: string;
  fetchImpl?: typeof globalThis.fetch;
}

// ============================================================================
// MODEL D — COLLECTIVE COORDINATION
// ============================================================================

export class ModelD_CollectiveCoordination {
  private config: ModelDConfig;
  private proposals: Map<string, Proposal> = new Map();
  private agents: Map<string, AgentConfig> = new Map();
  private privateKey: string;
  private readonly store: IStore;

  constructor(config: ModelDConfig, store: IStore = new ChainStore()) {
    this.config = config;
    this.privateKey = crypto.randomBytes(32).toString('hex');
    this.store = store;

    // Register agents
    for (const agent of config.agents) {
      this.agents.set(agent.id, agent);
    }
  }

  /**
   * Create a new proposal
   */
  propose(
    title: string,
    description: string,
    proposerId: string,
    type: 'strategic' | 'tactical' | 'operational' = 'tactical',
  ): Proposal {
    const proposal: Proposal = {
      id: `proposal-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      type,
      title,
      description,
      proposer: proposerId,
      status: 'voting',
      createdAt: new Date(),
      votingDeadline: new Date(Date.now() + this.config.votingTimeout),
      votes: [],
    };

    this.proposals.set(proposal.id, proposal);
    console.log(`📝 New proposal: "${title}" (by ${proposerId})`);
    void this.persistEvent('proposal', proposal.id, { proposal });

    return proposal;
  }

  /**
   * Cast a vote
   */
  vote(
    proposalId: string,
    agentId: string,
    choice: 'approve' | 'reject' | 'abstain',
    reason?: string,
  ): Vote {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposal ${proposalId} not found`);
    }

    if (proposal.status !== 'voting') {
      throw new Error(`Proposal is not in voting state: ${proposal.status}`);
    }

    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} not registered`);
    }

    // Check if already voted
    const existingVote = proposal.votes.find((v) => v.agentId === agentId);
    if (existingVote) {
      throw new Error(`Agent ${agentId} already voted on this proposal`);
    }

    // Check deadline
    if (proposal.votingDeadline && new Date() > proposal.votingDeadline) {
      throw new Error('Voting deadline has passed');
    }

    // Create vote with signature
    const vote: Vote = {
      agentId,
      choice,
      weight: agent.weight,
      reason,
      timestamp: new Date(),
      signature: this.signVote(agentId, choice, proposalId),
    };

    proposal.votes.push(vote);
    console.log(`🗳️  Vote cast: ${agentId} → ${choice} (weight: ${agent.weight})`);
    void this.persistEvent('vote', proposalId, { vote });

    // Check if we can close voting
    if (this.shouldCloseVoting(proposal)) {
      this.closeVoting(proposalId);
    }

    return vote;
  }

  /**
   * Check if voting should be closed
   */
  private shouldCloseVoting(proposal: Proposal): boolean {
    const totalAgents = this.agents.size;
    const votesCount = proposal.votes.length;

    // All agents voted
    if (votesCount >= totalAgents) {
      return true;
    }

    // Deadline passed
    if (proposal.votingDeadline && new Date() > proposal.votingDeadline) {
      return true;
    }

    // Early consensus reached (unanimous approve or reject)
    let approveCount = 0;
    let rejectCount = 0;
    for (const vote of proposal.votes) {
      if (vote.choice === 'approve') approveCount += 1;
      if (vote.choice === 'reject') rejectCount += 1;
    }

    if (approveCount > totalAgents / 2 || rejectCount > totalAgents / 2) {
      return true;
    }

    return false;
  }

  /**
   * Close voting and calculate result
   */
  closeVoting(proposalId: string): DecisionResult {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposal ${proposalId} not found`);
    }

    const { totalVotes, approveVotes, rejectVotes, abstainVotes, weightedApprove, weightedTotal } =
      this.summarizeVotes(proposal.votes);

    const weightedScore = weightedTotal > 0 ? weightedApprove / weightedTotal : 0;

    // Determine if consensus reached
    const consensusReached = weightedScore >= this.config.consensusThreshold;
    const approved = consensusReached && weightedScore >= 0.5;

    const result: DecisionResult = {
      approved,
      totalVotes,
      approveVotes,
      rejectVotes,
      abstainVotes,
      weightedScore,
      consensusReached,
    };

    proposal.result = result;
    proposal.status = approved ? 'approved' : 'rejected';

    console.log(
      `📊 Voting closed: ${approved ? '✅ APPROVED' : '❌ REJECTED'} (score: ${(weightedScore * 100).toFixed(1)}%)`,
    );
    void this.persistEvent('result', proposalId, { result, status: proposal.status });

    return result;
  }

  /**
   * Execute approved decision
   */
  execute(proposalId: string, executorId: string): void {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposal ${proposalId} not found`);
    }

    if (proposal.status !== 'approved') {
      throw new Error(`Proposal must be approved before execution`);
    }

    if (proposal.result) {
      proposal.result.executedBy = executorId;
      proposal.result.executedAt = new Date();
    }
    proposal.status = 'executed';

    console.log(`🚀 Decision executed: "${proposal.title}" (by ${executorId})`);
    void this.persistEvent('executed', proposalId, { executorId, result: proposal.result });
  }

  /**
   * Get active proposals
   */
  getActiveProposals(): Proposal[] {
    return Array.from(this.proposals.values()).filter((p) => p.status === 'voting');
  }

  /**
   * Get proposal by ID
   */
  getProposal(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  /**
   * Get agent's voting history
   */
  getAgentHistory(agentId: string): Proposal[] {
    return Array.from(this.proposals.values()).filter((p) =>
      p.votes.some((v) => v.agentId === agentId),
    );
  }

  /**
   * Calculate agent statistics
   */
  getAgentStats(agentId: string): {
    proposalsVoted: number;
    approvals: number;
    rejections: number;
    abstentions: number;
    averageWeight: number;
  } {
    let proposalsVoted = 0;
    let approvals = 0;
    let rejections = 0;
    let abstentions = 0;
    let totalWeight = 0;

    for (const proposal of this.proposals.values()) {
      for (const vote of proposal.votes) {
        if (vote.agentId !== agentId) continue;
        proposalsVoted += 1;
        totalWeight += vote.weight;
        if (vote.choice === 'approve') approvals += 1;
        else if (vote.choice === 'reject') rejections += 1;
        else abstentions += 1;
      }
    }

    return {
      proposalsVoted,
      approvals,
      rejections,
      abstentions,
      averageWeight: proposalsVoted > 0 ? totalWeight / proposalsVoted : 0,
    };
  }

  private summarizeVotes(votes: Vote[]): {
    totalVotes: number;
    approveVotes: number;
    rejectVotes: number;
    abstainVotes: number;
    weightedApprove: number;
    weightedTotal: number;
  } {
    let approveVotes = 0;
    let rejectVotes = 0;
    let abstainVotes = 0;
    let weightedApprove = 0;
    let weightedTotal = 0;

    for (const vote of votes) {
      if (vote.choice === 'approve') {
        approveVotes += 1;
        weightedApprove += vote.weight;
        weightedTotal += vote.weight;
        continue;
      }

      if (vote.choice === 'reject') {
        rejectVotes += 1;
        weightedTotal += vote.weight;
        continue;
      }

      abstainVotes += 1;
    }

    return {
      totalVotes: votes.length,
      approveVotes,
      rejectVotes,
      abstainVotes,
      weightedApprove,
      weightedTotal,
    };
  }

  private async persistEvent(
    event: 'proposal' | 'vote' | 'result' | 'executed',
    proposalId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.store.append('decisions', {
      type: 'decision',
      source: 'model-d',
      mode: 'collective',
      event,
      proposalId,
      payload,
      timestamp: new Date().toISOString(),
      tags: ['model-d', 'collective', event],
    });
  }

  /**
   * Sign vote (simplified)
   */
  private signVote(agentId: string, choice: string, proposalId: string): string {
    const data = `${agentId}:${choice}:${proposalId}:${Date.now()}`;
    return crypto.createHmac('sha256', this.privateKey).update(data).digest('hex');
  }

  /**
   * Verify vote signature
   */
  verifyVote(vote: Vote, _proposalId: string): boolean {
    // Simplified verification
    // In production, would use proper public-key crypto
    return vote.signature.length === 64;
  }

  /**
   * Export collective decision to block
   */
  toBlock(proposalId: string): Partial<Block> {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposal ${proposalId} not found`);
    }

    return {
      timestamp: new Date().toISOString(),
      chain: 'decision',
      data: {
        type: 'decision',
        content: `Collective Decision: ${proposal.title}`,
        tags: ['collective', proposal.type, proposal.status],
        // Include full decision data
        collectiveDecision: {
          proposalId: proposal.id,
          proposer: proposal.proposer,
          result: proposal.result,
          votes: proposal.votes.map((v) => ({
            agentId: v.agentId,
            choice: v.choice,
            weight: v.weight,
            timestamp: v.timestamp,
          })),
        },
      },
    };
  }
}

/**
 * Multi-Agent Network Coordinator
 */
export class AgentCoordinator {
  private localAgent: AgentConfig;
  private remoteAgents: Map<string, AgentConfig> = new Map();
  private modelD: ModelD_CollectiveCoordination;
  private readonly requestTimeoutMs: number;
  private readonly broadcastPath: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private lastBroadcast: BroadcastResult[] = [];

  constructor(
    localAgent: AgentConfig,
    remoteAgents: AgentConfig[],
    consensusThreshold: number = 0.6,
    options: AgentCoordinatorOptions = {},
  ) {
    this.localAgent = localAgent;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 5000;
    this.broadcastPath = options.broadcastPath ?? '/api/model-d/proposals';
    this.fetchImpl = options.fetchImpl ?? fetch;

    for (const agent of remoteAgents) {
      this.remoteAgents.set(agent.id, agent);
    }

    this.modelD = new ModelD_CollectiveCoordination({
      consensusThreshold,
      votingTimeout: 300000, // 5 minutes
      agents: [localAgent, ...remoteAgents],
    });
  }

  /**
   * Propose decision to network
   */
  async proposeToNetwork(
    title: string,
    description: string,
    type: 'strategic' | 'tactical' | 'operational' = 'tactical',
  ): Promise<Proposal> {
    const proposal = this.modelD.propose(title, description, this.localAgent.id, type);
    const results = await Promise.all(
      Array.from(this.remoteAgents.values()).map((agent) =>
        this.broadcastProposal(agent, proposal),
      ),
    );
    this.lastBroadcast = results;

    for (const result of results) {
      if (!result.vote) continue;
      try {
        await this.modelD.vote(
          proposal.id,
          result.agentId,
          result.vote.choice,
          result.vote.reason ?? 'Remote network vote',
        );
      } catch (error) {
        result.ok = false;
        result.error = error instanceof Error ? error.message : String(error);
      }
    }

    return proposal;
  }

  /**
   * Vote on proposal
   */
  async voteOnProposal(
    proposalId: string,
    choice: 'approve' | 'reject' | 'abstain',
    reason?: string,
  ): Promise<Vote> {
    return this.modelD.vote(proposalId, this.localAgent.id, choice, reason);
  }

  /**
   * Simulate network voting (for testing)
   */
  async simulateNetworkVoting(proposalId: string): Promise<void> {
    const proposal = this.modelD.getProposal(proposalId);
    if (!proposal) return;

    // Simulate remote agent votes
    for (const [agentId, agent] of this.remoteAgents) {
      // Random vote based on agent weight (higher weight = more likely to approve)
      const random = Math.random();
      const threshold = 0.5 - agent.weight * 0.1; // Higher weight = lower threshold

      const choice: 'approve' | 'reject' | 'abstain' =
        random < threshold ? 'approve' : random < 0.8 ? 'reject' : 'abstain';

      try {
        await this.modelD.vote(
          proposalId,
          agentId,
          choice,
          `Simulated vote (weight: ${agent.weight})`,
        );
      } catch {
        // Already voted or other error
      }
    }
  }

  /**
   * Returns the most recent network broadcast outcomes.
   */
  getLastBroadcastResults(): Array<{
    agentId: string;
    endpoint: string;
    ok: boolean;
    status?: number;
    vote?: BroadcastVote;
    error?: string;
  }> {
    return this.lastBroadcast.map((entry) => ({ ...entry }));
  }

  /**
   * Get coordinator stats
   */
  getStats(): {
    localAgent: string;
    remoteAgents: number;
    activeProposals: number;
    consensusThreshold: number;
  } {
    return {
      localAgent: this.localAgent.name,
      remoteAgents: this.remoteAgents.size,
      activeProposals: this.modelD.getActiveProposals().length,
      consensusThreshold: this.modelD['config'].consensusThreshold,
    };
  }

  private async broadcastProposal(
    agent: AgentConfig,
    proposal: Proposal,
  ): Promise<BroadcastResult> {
    if (!/^https?:\/\//i.test(agent.endpoint)) {
      return {
        agentId: agent.id,
        endpoint: agent.endpoint,
        ok: false,
        error: 'remote endpoint is not an HTTP(S) URL',
      };
    }

    const url = this.resolveBroadcastUrl(agent.endpoint);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.requestTimeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocol: 'memphis-model-d/v1',
          from: {
            id: this.localAgent.id,
            name: this.localAgent.name,
          },
          to: {
            id: agent.id,
            name: agent.name,
          },
          proposal: {
            id: proposal.id,
            title: proposal.title,
            description: proposal.description,
            proposer: proposal.proposer,
            type: proposal.type,
            status: proposal.status,
            createdAt: proposal.createdAt.toISOString(),
            votingDeadline: proposal.votingDeadline?.toISOString(),
          },
        }),
        signal: timeout.signal,
      });

      const result: BroadcastResult = {
        agentId: agent.id,
        endpoint: agent.endpoint,
        ok: response.ok,
        status: response.status,
      };

      const responseVote = await this.extractVote(response);
      if (responseVote) {
        result.vote = responseVote;
      }

      if (!response.ok) {
        result.error = `HTTP ${response.status}`;
      }

      return result;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        agentId: agent.id,
        endpoint: agent.endpoint,
        ok: false,
        error: reason,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private resolveBroadcastUrl(endpoint: string): string {
    const base = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
    const path = this.broadcastPath.startsWith('/') ? this.broadcastPath : `/${this.broadcastPath}`;
    return `${base}${path}`;
  }

  private async extractVote(response: Response): Promise<BroadcastVote | null> {
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('application/json')) {
      return null;
    }

    const payload = (await response.json()) as {
      vote?: {
        choice?: string;
        reason?: string;
      };
      choice?: string;
      reason?: string;
    } | null;
    if (!payload || typeof payload !== 'object') return null;

    const votePayload = payload.vote ?? payload;
    const choice = votePayload.choice;
    if (choice !== 'approve' && choice !== 'reject' && choice !== 'abstain') {
      return null;
    }

    return {
      choice,
      reason: typeof votePayload.reason === 'string' ? votePayload.reason : undefined,
    };
  }
}

export type { AgentConfig, ModelDConfig };
