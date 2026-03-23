import type Database from 'better-sqlite3';

/**
 * Persists seen proposal IDs for replay protection across restarts.
 */
export class SeenProposalRepository {
  constructor(private readonly db: Database.Database) {}

  has(proposalId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM seen_proposals WHERE proposal_id = ?')
      .get(proposalId);
    return row !== undefined;
  }

  record(proposalId: string): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO seen_proposals(proposal_id, received_at)
         VALUES (?, ?)`,
      )
      .run(proposalId, Date.now());
  }

  prune(windowMs: number): void {
    const cutoff = Date.now() - windowMs;
    this.db.prepare('DELETE FROM seen_proposals WHERE received_at < ?').run(cutoff);
  }
}
