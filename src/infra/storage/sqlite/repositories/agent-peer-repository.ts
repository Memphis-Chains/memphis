import type Database from 'better-sqlite3';

export type PeerStatus = 'online' | 'offline' | 'unknown';

export interface AgentPeer {
  did: string;
  name: string | null;
  endpoint: string;
  capabilities: string[];
  status: PeerStatus;
  lastSeenAt: string | null;
  registeredAt: string;
  updatedAt: string;
}

interface AgentPeerRow {
  did: string;
  name: string | null;
  endpoint: string;
  capabilities: string;
  status: string;
  last_seen_at: string | null;
  registered_at: string;
  updated_at: string;
}

function mapRow(row: AgentPeerRow): AgentPeer {
  let caps: string[] = [];
  try {
    caps = JSON.parse(row.capabilities) as string[];
  } catch {
    caps = [];
  }
  return {
    did: row.did,
    name: row.name,
    endpoint: row.endpoint,
    capabilities: caps,
    status: row.status as PeerStatus,
    lastSeenAt: row.last_seen_at,
    registeredAt: row.registered_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteAgentPeerRepository {
  constructor(private readonly db: Database.Database) {}

  /** Register or update a peer agent. */
  upsert(did: string, endpoint: string, capabilities: string[], name?: string): AgentPeer {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO agent_peers (did, name, endpoint, capabilities, status, last_seen_at, registered_at, updated_at)
         VALUES (?, ?, ?, ?, 'online', ?, ?, ?)
         ON CONFLICT(did) DO UPDATE SET
           name = COALESCE(excluded.name, agent_peers.name),
           endpoint = excluded.endpoint,
           capabilities = excluded.capabilities,
           status = 'online',
           last_seen_at = excluded.last_seen_at,
           updated_at = excluded.updated_at`,
      )
      .run(did, name ?? null, endpoint, JSON.stringify(capabilities), now, now, now);
    return this.getByDid(did)!;
  }

  /** Get a peer by DID. */
  getByDid(did: string): AgentPeer | null {
    const row = this.db.prepare('SELECT * FROM agent_peers WHERE did = ?').get(did) as
      | AgentPeerRow
      | undefined;
    return row ? mapRow(row) : null;
  }

  /** List all peers, optionally filtered by status. */
  list(status?: PeerStatus): AgentPeer[] {
    if (status) {
      return (
        this.db
          .prepare('SELECT * FROM agent_peers WHERE status = ? ORDER BY updated_at DESC')
          .all(status) as AgentPeerRow[]
      ).map(mapRow);
    }
    return (
      this.db.prepare('SELECT * FROM agent_peers ORDER BY updated_at DESC').all() as AgentPeerRow[]
    ).map(mapRow);
  }

  /** Update peer status (heartbeat or mark offline). */
  updateStatus(did: string, status: PeerStatus): void {
    const now = new Date().toISOString();
    const lastSeen = status === 'online' ? now : undefined;
    this.db
      .prepare(
        `UPDATE agent_peers SET status = ?, last_seen_at = COALESCE(?, last_seen_at), updated_at = ? WHERE did = ?`,
      )
      .run(status, lastSeen ?? null, now, did);
  }

  /** Remove a peer. */
  remove(did: string): boolean {
    const result = this.db.prepare('DELETE FROM agent_peers WHERE did = ?').run(did);
    return result.changes > 0;
  }

  /** Mark all peers not seen within windowMs as offline. */
  markStaleOffline(windowMs: number): number {
    const cutoff = new Date(Date.now() - windowMs).toISOString();
    const now = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE agent_peers SET status = 'offline', updated_at = ?
         WHERE status = 'online' AND last_seen_at < ?`,
      )
      .run(now, cutoff);
    return result.changes;
  }
}
