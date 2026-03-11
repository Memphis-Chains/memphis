import { GitContext, type InferredDecision, type GitCommit, type GitStats } from './git-context.js';
import { appendDecisionHistory, readDecisionHistory } from '../core/decision-history-store.js';
import { createDecision } from '../core/decision-lifecycle.js';

export interface PredictedDecision {
  type: string;
  title: string;
  confidence: number;
  rationale: string;
  evidence: string[];
}

export interface DecisionInferenceConfig {
  repoPath?: string;
  historyPath?: string;
  maxCommits?: number;
}

export class DecisionInference {
  private readonly gitContext: GitContext;
  private readonly historyPath?: string;
  private readonly maxCommits: number;

  constructor(config: DecisionInferenceConfig = {}) {
    this.gitContext = new GitContext(config.repoPath ?? process.cwd());
    this.historyPath = config.historyPath;
    this.maxCommits = config.maxCommits ?? 200;
  }

  /**
   * Infers decisions from recent git history and records any new ones.
   */
  async inferFromGit(sinceDays = 7): Promise<number> {
    if (!this.gitContext.isGitRepo()) return 0;

    const since = Date.now() - sinceDays * 24 * 60 * 60 * 1000;
    const commits = this.gitContext.getRecentCommits(this.maxCommits).filter((c) => c.timestamp.getTime() >= since);

    let inferred = 0;
    for (const commit of commits) {
      const decision = this.gitContext.extractDecision(commit);
      if (this.checkDecisionExists(decision.decisionId)) continue;
      await this.recordInferredDecision(decision);
      inferred += 1;
    }

    return inferred;
  }

  /**
   * Checks whether an inferred decision is already present in decision history.
   */
  checkDecisionExists(decisionId: string): boolean {
    const history = readDecisionHistory(this.historyPath);
    return history.some((entry) => entry.decision.id === decisionId);
  }

  /**
   * Persists a single inferred decision into decision history.
   */
  async recordInferredDecision(decision: InferredDecision): Promise<void> {
    const record = createDecision({
      id: decision.decisionId,
      title: decision.title,
      options: [decision.chosen],
      chosen: decision.chosen,
      context: `${decision.reasoning} | category=${decision.context.category}`,
      confidence: decision.confidence,
      refs: [
        `git:${decision.context.commit}`,
        `author:${decision.context.author}`,
      ],
    });

    appendDecisionHistory(record, {
      path: this.historyPath,
      correlationId: `model-c:${decision.context.commit.slice(0, 8)}`,
      chainRef: {
        chain: 'decision',
        index: 0,
        hash: decision.context.commit,
      },
    });
  }

  /**
   * Predicts the most likely next decision type from recent git and history signals.
   */
  async predictNextDecision(): Promise<PredictedDecision> {
    const commits = this.gitContext.getRecentCommits(Math.max(30, this.maxCommits));
    if (commits.length === 0) {
      return {
        type: 'unknown',
        title: 'No signal yet',
        confidence: 0,
        rationale: 'No git history available for prediction',
        evidence: [],
      };
    }

    const history = readDecisionHistory(this.historyPath);
    const typeScore = new Map<string, number>();

    commits.slice(0, 25).forEach((commit, index) => {
      const type = this.gitContext.detectCommitType(commit.message);
      const recencyWeight = 1 - index / 30;
      typeScore.set(type, (typeScore.get(type) ?? 0) + recencyWeight);
    });

    for (const item of history.slice(-50)) {
      const chosen = item.decision.chosen;
      if (!chosen) continue;
      typeScore.set(chosen, (typeScore.get(chosen) ?? 0) + 0.6);
    }

    const ranked = [...typeScore.entries()].sort((a, b) => b[1] - a[1]);
    const [type, score] = ranked[0] ?? ['unknown', 0];
    const total = ranked.reduce((sum, [, s]) => sum + s, 0) || 1;
    const confidence = Math.min(0.95, Number((score / total).toFixed(3)));

    return {
      type,
      title: this.predictedTitle(type),
      confidence,
      rationale: `Based on ${commits.length} recent commits + ${history.length} historical inferred decisions`,
      evidence: commits.slice(0, 5).map((c) => `${c.hash.slice(0, 7)}:${c.message}`),
    };
  }

  /**
   * Estimates prediction accuracy by replaying recent commit sequences.
   */
  evaluatePredictionAccuracy(limit = 25): number {
    const commits = this.gitContext.getRecentCommits(Math.max(10, limit + 5));
    if (commits.length < 5) return 0;

    let correct = 0;
    let total = 0;

    for (let i = 3; i < commits.length - 1; i += 1) {
      const previous = commits.slice(i - 3, i);
      const predicted = this.predictTypeFrom(previous);
      const actual = this.gitContext.detectCommitType(commits[i].message);
      total += 1;
      if (predicted === actual) correct += 1;
      if (total >= limit) break;
    }

    return total === 0 ? 0 : Number((correct / total).toFixed(3));
  }

  /**
   * Returns commit statistics for the requested recent time window.
   */
  getGitStats(sinceDays = 7): GitStats {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    return this.gitContext.getCommitStats(since);
  }

  private predictTypeFrom(commits: GitCommit[]): string {
    const counts = new Map<string, number>();
    for (const commit of commits) {
      const type = this.gitContext.detectCommitType(commit.message);
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown';
  }

  private predictedTitle(type: string): string {
    if (type === 'feature') return 'Likely next decision: expand functionality';
    if (type === 'bugfix') return 'Likely next decision: prioritize stability fixes';
    if (type === 'refactor') return 'Likely next decision: improve architecture';
    if (type === 'testing') return 'Likely next decision: increase validation coverage';
    if (type === 'documentation') return 'Likely next decision: clarify project knowledge';
    return 'Likely next decision: continue current development stream';
  }
}
