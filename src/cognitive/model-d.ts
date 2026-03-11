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
import type { Block } from '../memory/chain.js';
import type { 
  ModelDConfig, 
  AgentConfig,
  DecisionContext 
} from './types.js';
import { ChainStore, type IStore } from './store.js';

// ============================================================================
// TYPES
// ============================================================================

export interface Proposal {
  id: string;
  title: string;
  description: string;
  proposer: string;  // Agent ID
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
  signature: string;  // Cryptographic signature
}

export interface DecisionResult {
  approved: boolean;
  totalVotes: number;
  approveVotes: number;
  rejectVotes: number;
  abstainVotes: number;
  weightedScore: number;  // Weighted average
  consensusReached: boolean;
  executedBy?: string;
  executedAt?: Date;
}

export interface CollectiveDecision {
  proposal: Proposal;
  participants: AgentConfig[];
  quorum: number;  // Minimum participation
  consensusThreshold: number;  // 0.0-1.0
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
    type: 'strategic' | 'tactical' | 'operational' = 'tactical'
  ): Proposal {
    const proposal: Proposal = {
      id: `proposal-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      title,
      description,
      proposer: proposerId,
      type,
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
    reason?: string
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
    const existingVote = proposal.votes.find(v => v.agentId === agentId);
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
    const approveCount = proposal.votes.filter(v => v.choice === 'approve').length;
    const rejectCount = proposal.votes.filter(v => v.choice === 'reject').length;
    
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

    const totalVotes = proposal.votes.length;
    const approveVotes = proposal.votes.filter(v => v.choice === 'approve').length;
    const rejectVotes = proposal.votes.filter(v => v.choice === 'reject').length;
    const abstainVotes = proposal.votes.filter(v => v.choice === 'abstain').length;

    // Calculate weighted score
    let weightedApprove = 0;
    let weightedTotal = 0;
    
    for (const vote of proposal.votes) {
      if (vote.choice !== 'abstain') {
        weightedTotal += vote.weight;
        if (vote.choice === 'approve') {
          weightedApprove += vote.weight;
        }
      }
    }

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

    console.log(`📊 Voting closed: ${approved ? '✅ APPROVED' : '❌ REJECTED'} (score: ${(weightedScore * 100).toFixed(1)}%)`);
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
    return Array.from(this.proposals.values())
      .filter(p => p.status === 'voting');
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
    return Array.from(this.proposals.values())
      .filter(p => p.votes.some(v => v.agentId === agentId));
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
    const history = this.getAgentHistory(agentId);
    const votes = history.flatMap(p => p.votes.filter(v => v.agentId === agentId));

    return {
      proposalsVoted: votes.length,
      approvals: votes.filter(v => v.choice === 'approve').length,
      rejections: votes.filter(v => v.choice === 'reject').length,
      abstentions: votes.filter(v => v.choice === 'abstain').length,
      averageWeight: votes.length > 0 
        ? votes.reduce((sum, v) => sum + v.weight, 0) / votes.length 
        : 0,
    };
  }

  /**
   * Sign vote (simplified)
   */
  private signVote(agentId: string, choice: string, proposalId: string): string {
    const data = `${agentId}:${choice}:${proposalId}:${Date.now()}`;
    return crypto
      .createHmac('sha256', this.privateKey)
      .update(data)
      .digest('hex');
  }

  /**
   * Verify vote signature
   */
  verifyVote(vote: Vote, proposalId: string): boolean {
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
          votes: proposal.votes.map(v => ({
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

  constructor(
    localAgent: AgentConfig,
    remoteAgents: AgentConfig[],
    consensusThreshold: number = 0.6
  ) {
    this.localAgent = localAgent;
    
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
    type: 'strategic' | 'tactical' | 'operational' = 'tactical'
  ): Promise<Proposal> {
    const proposal = this.modelD.propose(title, description, this.localAgent.id, type);
    
    // TODO: Broadcast to remote agents via network
    // For now, simulate local voting
    
    return proposal;
  }

  /**
   * Vote on proposal
   */
  async voteOnProposal(
    proposalId: string,
    choice: 'approve' | 'reject' | 'abstain',
    reason?: string
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
      const threshold = 0.5 - (agent.weight * 0.1); // Higher weight = lower threshold
      
      const choice: 'approve' | 'reject' | 'abstain' = 
        random < threshold ? 'approve' : 
        random < 0.8 ? 'reject' : 
        'abstain';

      try {
        await this.modelD.vote(proposalId, agentId, choice, `Simulated vote (weight: ${agent.weight})`);
      } catch {
        // Already voted or other error
      }
    }
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
}

export type { AgentConfig, ModelDConfig };
