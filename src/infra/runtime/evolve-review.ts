import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type Database from 'better-sqlite3';

const exec = promisify(execFile);

export type EvolveReview = {
  sessionId: string; root: string; worktree: string; branch: string; target: string;
  base: string; commit: string; testSummary: string; status: 'prepared' | 'merging' | 'merged' | 'rejected';
  planId?: string; stepIdx?: number;
};

/** Separate table avoids rewriting the existing evolve_sessions CHECK constraint. */
export class EvolveReviewStore {
  constructor(private db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS evolve_reviews (
      session_id TEXT PRIMARY KEY, root TEXT NOT NULL, worktree TEXT NOT NULL,
      branch TEXT NOT NULL, target TEXT NOT NULL, base TEXT NOT NULL, commit_hash TEXT NOT NULL,
      test_summary TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('prepared','merging','merged','rejected')),
      plan_id TEXT, step_idx INTEGER
    );
    CREATE TABLE IF NOT EXISTS evolve_review_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
      action TEXT NOT NULL, commit_hash TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
  }
  create(r: EvolveReview): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO evolve_reviews VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(
        r.sessionId, r.root, r.worktree, r.branch, r.target, r.base, r.commit, r.testSummary, r.status, r.planId ?? null, r.stepIdx ?? null);
      this.db.prepare('INSERT INTO evolve_review_events(session_id,action,commit_hash,created_at) VALUES(?,?,?,?)')
        .run(r.sessionId, 'prepared', r.commit, new Date().toISOString());
    })();
  }
  get(id: string): EvolveReview | null {
    const row = this.db.prepare('SELECT * FROM evolve_reviews WHERE session_id=?').get(id) as Record<string, string> | undefined;
    return row ? { sessionId: row.session_id, root: row.root, worktree: row.worktree, branch: row.branch,
      target: row.target, base: row.base, commit: row.commit_hash, testSummary: row.test_summary,
      status: row.status as EvolveReview['status'], planId: row.plan_id ?? undefined,
      stepIdx: row.step_idx == null ? undefined : Number(row.step_idx) } : null;
  }
  events(id: string): Array<{ action: string; commit: string; at: string }> {
    return this.db.prepare('SELECT action,commit_hash AS "commit",created_at AS at FROM evolve_review_events WHERE session_id=? ORDER BY id')
      .all(id) as Array<{ action: string; commit: string; at: string }>;
  }
  transition(id: string, from: EvolveReview['status'], to: EvolveReview['status']): void {
    this.db.transaction(() => {
      if (this.db.prepare('UPDATE evolve_reviews SET status=? WHERE session_id=? AND status=?').run(to, id, from).changes !== 1)
        throw new Error('evolution review changed concurrently');
      const review = this.get(id);
      if (!review) throw new Error('evolution review disappeared');
      this.db.prepare('INSERT INTO evolve_review_events(session_id,action,commit_hash,created_at) VALUES(?,?,?,?)')
        .run(id, `${from}->${to}`, review.commit, new Date().toISOString());
    }).immediate();
  }
}

export async function evolveGit(root: string, args: string[], rawEnv: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: root, maxBuffer: 4 * 1024 * 1024,
    env: { PATH: rawEnv.PATH, HOME: rawEnv.HOME, SYSTEMROOT: rawEnv.SYSTEMROOT,
      GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
  return stdout.trimEnd();
}

export async function inspectEvolveReview(review: EvolveReview, root: string): Promise<string> {
  if (review.root !== root || !/^[a-f0-9]{40,64}$/.test(review.base) || !/^[a-f0-9]{40,64}$/.test(review.commit))
    throw new Error('review repository or commit is invalid');
  if (review.status !== 'prepared') throw new Error(`review is ${review.status}, not prepared`);
  if (await evolveGit(root, ['rev-parse', '--verify', `refs/heads/${review.branch}`]) !== review.commit)
    throw new Error('prepared branch changed since tests');
  const parents = (await evolveGit(root, ['rev-list', '--parents', '-n', '1', review.commit])).split(' ');
  if (parents.length !== 2 || parents[1] !== review.base) throw new Error('prepared commit is not based on the reviewed base');
  return evolveGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--binary', review.base, review.commit, '--']);
}

export async function mergeEvolveReview(store: EvolveReviewStore, id: string, root: string, confirmedCommit: string): Promise<void> {
  const review = store.get(id);
  if (!review || review.commit !== confirmedCommit) throw new Error('review or confirmed commit does not match');
  await inspectEvolveReview(review, root);
  if (await evolveGit(root, ['branch', '--show-current']) !== review.target ||
      await evolveGit(root, ['rev-parse', 'HEAD']) !== review.base ||
      await evolveGit(root, ['status', '--porcelain', '--untracked-files=all']) !== '')
    throw new Error('target branch is dirty, changed, or not checked out; review again');
  store.transition(id, 'prepared', 'merging');
  // A kill or ambiguous Git failure stays in 'merging' for operator review;
  // never repeat an effect merely because it was not acknowledged.
  await evolveGit(root, ['merge', '--ff-only', '--no-edit', review.commit]);
  if (await evolveGit(root, ['rev-parse', 'HEAD']) !== review.commit ||
      await evolveGit(root, ['status', '--porcelain', '--untracked-files=all']) !== '') throw new Error('merge outcome is uncertain');
  store.transition(id, 'merging', 'merged');
}

export async function reconcileEvolveReview(store: EvolveReviewStore, id: string, root: string): Promise<'prepared' | 'merged'> {
  const review = store.get(id);
  if (!review || review.status !== 'merging' || review.root !== root) throw new Error('no interrupted merge for this repository');
  if (await evolveGit(root, ['branch', '--show-current']) !== review.target ||
      await evolveGit(root, ['status', '--porcelain', '--untracked-files=all']) !== '')
    throw new Error('target worktree is not clean on the reviewed branch');
  const head = await evolveGit(root, ['rev-parse', 'HEAD']);
  if (head === review.commit) { store.transition(id, 'merging', 'merged'); return 'merged'; }
  if (head === review.base) { store.transition(id, 'merging', 'prepared'); return 'prepared'; }
  throw new Error('target HEAD matches neither reviewed base nor commit; inspect manually');
}
