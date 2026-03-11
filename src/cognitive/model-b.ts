/**
 * Model B — Inferred Decisions
 *
 * Detects implicit decisions from behavior signals:
 * - Git commit history
 * - File change patterns
 * - Activity/task-shift patterns
 */

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

import { ChainStore, IStore } from './store.js';
import type { Block } from '../memory/chain.js';

export type InferredDecisionSource = 'git' | 'files' | 'activity';

export interface ModelBConfig {
  repoPath: string;
  sinceDays: number;
  maxCommits: number;
  activityWindowSize: number;
  confidenceThreshold: number;
  includeMerges: boolean;
}

export interface InferredDecision {
  id: string;
  source: InferredDecisionSource;
  title: string;
  reasoning: string;
  confidence: number;
  category: 'strategic' | 'tactical' | 'technical';
  evidence: string[];
  timestamp: Date;
}

interface GitCommit {
  hash: string;
  subject: string;
  changedFiles: string[];
  timestamp: Date;
}

const DEFAULT_CONFIG: ModelBConfig = {
  repoPath: process.cwd(),
  sinceDays: 7,
  maxCommits: 100,
  activityWindowSize: 6,
  confidenceThreshold: 0.45,
  includeMerges: false,
};

const COMMIT_PATTERNS: Array<{
  regex: RegExp;
  title: string;
  category: InferredDecision['category'];
  baseConfidence: number;
}> = [
  {
    regex: /migrate\s+(.+?)\s+to\s+(.+)/i,
    title: 'Technology migration detected',
    category: 'strategic',
    baseConfidence: 0.78,
  },
  {
    regex: /refactor/i,
    title: 'Refactoring strategy chosen',
    category: 'technical',
    baseConfidence: 0.7,
  },
  {
    regex: /revert|rollback/i,
    title: 'Previous direction abandoned',
    category: 'tactical',
    baseConfidence: 0.72,
  },
  {
    regex: /feat|implement|add/i,
    title: 'Feature direction selected',
    category: 'strategic',
    baseConfidence: 0.62,
  },
  {
    regex: /fix|hotfix/i,
    title: 'Stability prioritized over expansion',
    category: 'tactical',
    baseConfidence: 0.58,
  },
];

const FILE_PATTERNS: Array<{
  file: RegExp;
  title: string;
  category: InferredDecision['category'];
  baseConfidence: number;
}> = [
  {
    file: /(^|\/)package\.json$/i,
    title: 'Dependency strategy updated',
    category: 'technical',
    baseConfidence: 0.65,
  },
  {
    file: /(^|\/)pnpm-lock\.yaml$|(^|\/)package-lock\.json$|(^|\/)yarn\.lock$/i,
    title: 'Dependency set frozen/shifted',
    category: 'technical',
    baseConfidence: 0.57,
  },
  {
    file: /(^|\/)(tsconfig|jsconfig)\.json$/i,
    title: 'Compiler/runtime constraints changed',
    category: 'technical',
    baseConfidence: 0.64,
  },
  {
    file: /(^|\/)(Dockerfile|docker-compose\.ya?ml)$/i,
    title: 'Delivery/runtime environment chosen',
    category: 'strategic',
    baseConfidence: 0.68,
  },
  {
    file: /(^|\/)README\.md$/i,
    title: 'Project communication/documentation emphasis',
    category: 'tactical',
    baseConfidence: 0.45,
  },
  {
    file: /(^|\/)(test|tests|__tests__)\//i,
    title: 'Verification-first behavior detected',
    category: 'tactical',
    baseConfidence: 0.52,
  },
];

export class ModelB_InferredDecisions {
  private readonly config: ModelBConfig;
  private readonly store: IStore;

  constructor(config?: Partial<ModelBConfig>, store: IStore = new ChainStore()) {
    this.config = { ...DEFAULT_CONFIG, ...(config ?? {}) };
    this.store = store;
  }

  /**
   * Infers decisions from commit-message patterns in recent git history.
   */
  inferFromGit(): InferredDecision[] {
    const commits = this.loadCommits();
    const inferred: InferredDecision[] = [];

    for (const commit of commits) {
      for (const pattern of COMMIT_PATTERNS) {
        if (!pattern.regex.test(commit.subject)) continue;

        inferred.push({
          id: `git-${commit.hash}`,
          source: 'git',
          title: pattern.title,
          reasoning: `Commit message matched pattern (${pattern.regex}): "${commit.subject}"`,
          confidence: this.scoreConfidence(pattern.baseConfidence, {
            messageLength: commit.subject.length,
            changedFileCount: commit.changedFiles.length,
            recencyDays: this.daysSince(commit.timestamp),
          }),
          category: pattern.category,
          evidence: [
            `commit:${commit.hash.slice(0, 7)}`,
            `subject:${commit.subject}`,
            `files:${commit.changedFiles.length}`,
          ],
          timestamp: commit.timestamp,
        });

        break;
      }
    }

    return this.filterAndDeduplicate(inferred);
  }

  /**
   * Infers decisions from recurring file-change patterns.
   */
  inferFromFileChanges(): InferredDecision[] {
    const commits = this.loadCommits();
    const grouped = new Map<
      string,
      {
        count: number;
        latest: Date;
        category: InferredDecision['category'];
        baseConfidence: number;
        evidence: Set<string>;
      }
    >();

    for (const commit of commits) {
      for (const file of commit.changedFiles) {
        const normalized = file.replace(/\\/g, '/');
        const pattern = this.resolveFilePattern(normalized);
        if (!pattern) continue;

        const key = pattern.title;
        const current = grouped.get(key) ?? {
          count: 0,
          latest: commit.timestamp,
          category: pattern.category,
          baseConfidence: pattern.baseConfidence,
          evidence: new Set<string>(),
        };

        current.count += 1;
        if (commit.timestamp > current.latest) current.latest = commit.timestamp;
        current.evidence.add(`file:${normalized}`);
        current.evidence.add(`commit:${commit.hash.slice(0, 7)}`);
        grouped.set(key, current);
      }
    }

    const inferred: InferredDecision[] = [];
    for (const [title, data] of grouped) {
      inferred.push({
        id: `files-${this.stableId(title)}`,
        source: 'files',
        title,
        reasoning: `Detected recurring file-change pattern (${data.count} hits)`,
        confidence: this.scoreConfidence(data.baseConfidence, {
          recurrence: data.count,
          recencyDays: this.daysSince(data.latest),
        }),
        category: data.category,
        evidence: Array.from(data.evidence).slice(0, 8),
        timestamp: data.latest,
      });
    }

    return this.filterAndDeduplicate(inferred);
  }

  /**
   * Infers decisions from shifts in recent activity tags.
   */
  inferFromActivity(blocks: Block[]): InferredDecision[] {
    if (!Array.isArray(blocks) || blocks.length === 0) return [];

    const ordered = [...blocks]
      .filter((b) => !!b.timestamp)
      .sort((a, b) => new Date(a.timestamp ?? 0).getTime() - new Date(b.timestamp ?? 0).getTime());

    if (ordered.length < 3) return [];

    const inferred: InferredDecision[] = [];
    const window = Math.max(3, this.config.activityWindowSize);
    const halfWindow = Math.floor(window / 2);

    for (let i = window; i < ordered.length; i += 1) {
      const prevTags = this.tagHistogramRange(ordered, i - window, i);
      const nextTags = this.tagHistogramRange(ordered, Math.max(0, i - halfWindow), i + 1);

      const shift = this.distributionShift(prevTags, nextTags);
      if (shift < 0.5) continue;

      const dominantPrev = this.dominantTag(prevTags);
      const dominantNext = this.dominantTag(nextTags);
      if (!dominantPrev || !dominantNext || dominantPrev === dominantNext) continue;

      const pivot = ordered[i];
      const pivotTs = new Date(pivot.timestamp ?? Date.now());

      inferred.push({
        id: `activity-${pivotTs.getTime()}-${this.stableId(`${dominantPrev}-${dominantNext}`)}`,
        source: 'activity',
        title: `Task focus shifted: ${dominantPrev} → ${dominantNext}`,
        reasoning: `Behavior profile changed significantly (shift=${shift.toFixed(2)})`,
        confidence: this.scoreConfidence(0.52, {
          shiftStrength: shift,
          recencyDays: this.daysSince(pivotTs),
        }),
        category: 'tactical',
        evidence: [`from:${dominantPrev}`, `to:${dominantNext}`, `window:${window}`],
        timestamp: pivotTs,
      });
    }

    return this.filterAndDeduplicate(inferred);
  }

  /**
   * Runs all inference strategies and returns the merged decision set.
   */
  inferAll(blocks: Block[] = []): InferredDecision[] {
    const all = [
      ...this.inferFromGit(),
      ...this.inferFromFileChanges(),
      ...this.inferFromActivity(blocks),
    ];

    return this.filterAndDeduplicate(all).sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Runs inference and persists the resulting decisions to a chain.
   */
  async inferAndPersist(blocks: Block[] = [], chain = 'decisions'): Promise<InferredDecision[]> {
    const inferred = this.inferAll(blocks);
    await this.persistDecisions(inferred, chain);
    return inferred;
  }

  /**
   * Persists inferred decisions as decision blocks in the target chain.
   */
  async persistDecisions(decisions: InferredDecision[], chain = 'decisions'): Promise<void> {
    for (const decision of decisions) {
      await this.store.append(chain, {
        type: 'decision',
        source: 'model-b',
        mode: 'inferred',
        inferredId: decision.id,
        inferredSource: decision.source,
        title: decision.title,
        content: decision.reasoning,
        confidence: decision.confidence,
        category: decision.category,
        evidence: decision.evidence,
        timestamp: decision.timestamp.toISOString(),
        tags: ['model-b', 'inferred', decision.source, decision.category],
      });
    }
  }

  private loadCommits(): GitCommit[] {
    const args = [
      '-C',
      this.config.repoPath,
      'log',
      `--since=${this.config.sinceDays} days ago`,
      '-n',
      String(this.config.maxCommits),
      '--name-only',
      '--pretty=format:%H|%ct|%s',
    ];

    if (!this.config.includeMerges) {
      args.splice(3, 0, '--no-merges');
    }

    const result = spawnSync('git', args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.status !== 0) {
      return [];
    }

    const output = result.stdout ?? '';

    const lines = output.split('\n');
    const commits: GitCommit[] = [];
    let current: GitCommit | null = null;

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      const header = line.match(/^([a-f0-9]{7,40})\|(\d+)\|(.*)$/i);
      if (header) {
        if (current) commits.push(current);
        current = {
          hash: header[1],
          timestamp: new Date(Number(header[2]) * 1000),
          subject: header[3].trim(),
          changedFiles: [],
        };
        continue;
      }

      if (current) {
        current.changedFiles.push(path.normalize(line));
      }
    }

    if (current) commits.push(current);
    return commits;
  }

  private scoreConfidence(
    base: number,
    signals: {
      messageLength?: number;
      changedFileCount?: number;
      recurrence?: number;
      shiftStrength?: number;
      recencyDays?: number;
    },
  ): number {
    let score = base;

    if (signals.messageLength) {
      score += Math.min(0.06, signals.messageLength / 400);
    }
    if (signals.changedFileCount) {
      score += Math.min(0.07, signals.changedFileCount / 50);
    }
    if (signals.recurrence) {
      score += Math.min(0.12, (signals.recurrence - 1) * 0.03);
    }
    if (signals.shiftStrength) {
      score += Math.min(0.14, Math.max(0, signals.shiftStrength - 0.5) * 0.4);
    }
    if (signals.recencyDays !== undefined) {
      score -= Math.min(0.15, signals.recencyDays * 0.02);
    }

    // inferred decisions should never be absolute certainty
    return Math.max(0.2, Math.min(0.9, score));
  }

  private daysSince(ts: Date): number {
    return Math.max(0, (Date.now() - ts.getTime()) / (1000 * 60 * 60 * 24));
  }

  private tagHistogram(blocks: Block[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const block of blocks) {
      const tags = block.data?.tags ?? [];
      for (const tag of tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return counts;
  }

  private tagHistogramRange(blocks: Block[], start: number, endExclusive: number): Map<string, number> {
    const counts = new Map<string, number>();
    for (let i = start; i < endExclusive; i += 1) {
      const tags = blocks[i]?.data?.tags ?? [];
      for (const tag of tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return counts;
  }

  private dominantTag(hist: Map<string, number>): string | null {
    let top: string | null = null;
    let count = -1;
    for (const [tag, n] of hist) {
      if (n > count) {
        top = tag;
        count = n;
      }
    }
    return top;
  }

  private distributionShift(a: Map<string, number>, b: Map<string, number>): number {
    let sum = 0;
    let totalA = 0;
    let totalB = 0;

    for (const n of a.values()) totalA += n;
    for (const n of b.values()) totalB += n;
    if (totalA === 0) totalA = 1;
    if (totalB === 0) totalB = 1;

    for (const [key, countA] of a) {
      const pa = countA / totalA;
      const pb = (b.get(key) ?? 0) / totalB;
      sum += Math.abs(pa - pb);
    }
    for (const [key, countB] of b) {
      if (a.has(key)) continue;
      const pb = countB / totalB;
      sum += pb;
    }

    return Math.min(1, sum / 2);
  }

  private resolveFilePattern(normalizedPath: string): (typeof FILE_PATTERNS)[number] | null {
    for (const pattern of FILE_PATTERNS) {
      if (pattern.file.test(normalizedPath)) {
        return pattern;
      }
    }
    return null;
  }

  private filterAndDeduplicate(items: InferredDecision[]): InferredDecision[] {
    const map = new Map<string, InferredDecision>();

    for (const item of items) {
      if (item.confidence < this.config.confidenceThreshold) continue;
      const key = `${item.source}:${item.title.toLowerCase()}`;
      const existing = map.get(key);
      if (!existing || existing.confidence < item.confidence) {
        map.set(key, item);
      }
    }

    return Array.from(map.values());
  }

  private stableId(input: string): string {
    let hash = 0;
    for (let i = 0; i < input.length; i += 1) {
      hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
    }
    return Math.abs(hash).toString(36);
  }
}
