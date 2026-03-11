import { execFileSync } from 'node:child_process';

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  email: string;
  timestamp: Date;
  files: string[];
}

export interface InferredDecision {
  schema: 'decision:v1';
  decisionId: string;
  mode: 'inferred';
  status: 'active';
  scope: 'project';
  title: string;
  chosen: string;
  reasoning: string;
  confidence: number;
  context: {
    commit: string;
    author: string;
    category: string;
    files: string[];
  };
}

export interface GitStats {
  total: number;
  byType: Record<string, number>;
  byAuthor: Record<string, number>;
  byCategory: Record<string, number>;
}

function runGit(repoPath: string, args: string[], allowFailure = false): string {
  try {
    return execFileSync('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    if (allowFailure) {
      return '';
    }
    throw new Error(`git command failed: git ${args.join(' ')}`);
  }
}

export class GitContext {
  constructor(private readonly repoPath: string = process.cwd()) {}

  isGitRepo(): boolean {
    return runGit(this.repoPath, ['rev-parse', '--git-dir'], true).length > 0;
  }

  getRecentCommits(limit = 20): GitCommit[] {
    if (!this.isGitRepo()) {
      return [];
    }

    const output = runGit(
      this.repoPath,
      [
        'log',
        '--date-order',
        '-n',
        String(limit),
        '--name-only',
        '--pretty=format:__COMMIT__|%H|%an|%ae|%at|%s',
      ],
      true,
    );
    if (!output) {
      return [];
    }

    const commits: GitCommit[] = [];
    let current: GitCommit | null = null;

    for (const raw of output.split('\n')) {
      const line = raw.trim();
      if (!line) {
        continue;
      }

      if (line.startsWith('__COMMIT__|')) {
        if (current) {
          commits.push(current);
        }
        const [, hash, author, email, ts, message] = line.split('|');
        current = {
          hash: hash ?? '',
          author: author ?? '',
          email: email ?? '',
          timestamp: new Date(Number(ts ?? '0') * 1000),
          message: message ?? '',
          files: [],
        };
        continue;
      }

      if (current) {
        current.files.push(line);
      }
    }

    if (current) {
      commits.push(current);
    }
    return commits;
  }

  extractDecision(commit: GitCommit): InferredDecision {
    const chosen = this.detectCommitType(commit.message);
    const category = this.detectCategory(commit.message);

    return {
      schema: 'decision:v1',
      decisionId: `git-${commit.hash.slice(0, 16)}`,
      mode: 'inferred',
      status: 'active',
      scope: 'project',
      title: this.normalizeTitle(commit.message, chosen),
      chosen,
      reasoning: `Inferred from commit ${commit.hash.slice(0, 8)} by ${commit.author}`,
      confidence: this.baseConfidence(chosen),
      context: {
        commit: commit.hash,
        author: commit.author,
        category,
        files: commit.files,
      },
    };
  }

  detectCommitType(message: string): string {
    const lowered = message.toLowerCase();
    if (/^(feat|feature)(\(.+\))?:/.test(lowered)) return 'feature';
    if (/^(fix|bugfix|hotfix)(\(.+\))?:/.test(lowered)) return 'bugfix';
    if (/^(refactor|ref)(\(.+\))?:/.test(lowered)) return 'refactor';
    if (/^(docs?|doc)(\(.+\))?:/.test(lowered)) return 'documentation';
    if (/^(test|tests)(\(.+\))?:/.test(lowered)) return 'testing';
    if (/^(chore|build|ci)(\(.+\))?:/.test(lowered)) return 'maintenance';
    return 'unknown';
  }

  detectCategory(message: string): string {
    const lowered = message.toLowerCase();
    if (lowered.includes('chain') || lowered.includes('block')) return 'blockchain';
    if (lowered.includes('git')) return 'git';
    if (lowered.includes('cognitive') || lowered.includes('model')) return 'cognitive';
    if (lowered.includes('test')) return 'testing';
    if (lowered.includes('api')) return 'api';
    if (lowered.includes('ui') || lowered.includes('ux')) return 'frontend';
    return 'general';
  }

  getCommitStats(since: Date = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)): GitStats {
    const recent = this.getRecentCommits(200).filter((commit) => commit.timestamp >= since);
    const stats: GitStats = {
      total: recent.length,
      byType: {},
      byAuthor: {},
      byCategory: {},
    };

    for (const commit of recent) {
      const type = this.detectCommitType(commit.message);
      const category = this.detectCategory(commit.message);
      stats.byType[type] = (stats.byType[type] ?? 0) + 1;
      stats.byAuthor[commit.author] = (stats.byAuthor[commit.author] ?? 0) + 1;
      stats.byCategory[category] = (stats.byCategory[category] ?? 0) + 1;
    }

    return stats;
  }

  private baseConfidence(type: string): number {
    if (type === 'feature' || type === 'bugfix') return 0.82;
    if (type === 'refactor') return 0.78;
    if (type === 'documentation' || type === 'testing') return 0.72;
    return 0.65;
  }

  private normalizeTitle(message: string, type: string): string {
    const clean = message.replace(/^[a-z]+(\(.+\))?:\s*/i, '').trim();
    if (!clean) {
      return `Inferred ${type} decision`;
    }
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }
}
