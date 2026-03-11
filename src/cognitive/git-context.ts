import { execSync } from 'node:child_process';

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

export class GitContext {
  constructor(private readonly repoPath: string = process.cwd()) {}

  isGitRepo(): boolean {
    try {
      execSync('git rev-parse --git-dir', { cwd: this.repoPath, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  getRecentCommits(limit = 20): GitCommit[] {
    if (!this.isGitRepo()) return [];

    try {
      const output = execSync(
        `git log --date-order -n ${limit} --name-only --pretty=format:"__COMMIT__|%H|%an|%ae|%at|%s"`,
        { cwd: this.repoPath, encoding: 'utf8' },
      );

      const lines = output.split('\n');
      const commits: GitCommit[] = [];
      let current: GitCommit | null = null;

      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;

        if (line.startsWith('__COMMIT__|')) {
          if (current) commits.push(current);
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

      if (current) commits.push(current);
      return commits;
    } catch {
      return [];
    }
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
    const m = message.toLowerCase();
    if (/^(feat|feature)(\(.+\))?:/.test(m)) return 'feature';
    if (/^(fix|bugfix|hotfix)(\(.+\))?:/.test(m)) return 'bugfix';
    if (/^(refactor|ref)(\(.+\))?:/.test(m)) return 'refactor';
    if (/^(docs?|doc)(\(.+\))?:/.test(m)) return 'documentation';
    if (/^(test|tests)(\(.+\))?:/.test(m)) return 'testing';
    if (/^(chore|build|ci)(\(.+\))?:/.test(m)) return 'maintenance';
    return 'unknown';
  }

  detectCategory(message: string): string {
    const m = message.toLowerCase();
    if (m.includes('chain') || m.includes('block')) return 'blockchain';
    if (m.includes('git')) return 'git';
    if (m.includes('cognitive') || m.includes('model')) return 'cognitive';
    if (m.includes('test')) return 'testing';
    if (m.includes('api')) return 'api';
    if (m.includes('ui') || m.includes('ux')) return 'frontend';
    return 'general';
  }

  getCommitStats(since: Date = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)): GitStats {
    const recent = this.getRecentCommits(200).filter((c) => c.timestamp >= since);

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
    if (!clean) return `Inferred ${type} decision`;
    return clean.charAt(0).toUpperCase() + clean.slice(1);
  }
}
