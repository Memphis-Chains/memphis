import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type SyncAgent = {
  did: `did:${string}`;
  name?: string;
  endpoint: string;
  capabilities: string[];
  lastSeen: string;
  status: 'online' | 'offline' | 'unknown';
};

type PersistedRegistry = {
  agents: SyncAgent[];
  updatedAt: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

export class SyncAgentRegistry {
  constructor(private readonly storagePath = resolve('data/sync-agents.json')) {}

  list(): SyncAgent[] {
    return this.read().agents;
  }

  get(did: string): SyncAgent | null {
    return this.list().find((agent) => agent.did === did) ?? null;
  }

  upsert(agent: Omit<SyncAgent, 'lastSeen'> & { lastSeen?: string }): SyncAgent {
    const registry = this.read();
    const next: SyncAgent = {
      ...agent,
      lastSeen: agent.lastSeen ?? nowIso(),
    };
    const idx = registry.agents.findIndex((item) => item.did === next.did);
    if (idx >= 0) registry.agents[idx] = next;
    else registry.agents.push(next);
    this.write(registry.agents);
    return next;
  }

  discover(): SyncAgent[] {
    const discovered = this.discoverFromEnv();
    for (const agent of discovered) {
      this.upsert(agent);
    }
    return this.list();
  }

  private discoverFromEnv(): Array<Omit<SyncAgent, 'lastSeen'>> {
    // Format: MEMPHIS_SYNC_PEERS="did:pc-zona@ws://10.0.0.80:8787,did:watra@ws://10.0.0.22:8787"
    const peers = process.env.MEMPHIS_SYNC_PEERS?.trim();
    if (!peers) return [];

    const result: Array<Omit<SyncAgent, 'lastSeen'>> = [];
    for (const entry of peers
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)) {
      const [didRaw, endpointRaw] = entry.split('@');
      const did = didRaw?.trim();
      const endpoint = endpointRaw?.trim();
      if (!did || !endpoint || !did.startsWith('did:')) continue;
      result.push({
        did: did as `did:${string}`,
        endpoint,
        name: did.replace('did:', ''),
        capabilities: ['sync.push', 'sync.pull', 'chain.diff'],
        status: 'unknown',
      });
    }

    return result;
  }

  private read(): PersistedRegistry {
    if (!existsSync(this.storagePath)) {
      return { agents: [], updatedAt: nowIso() };
    }

    const raw = JSON.parse(readFileSync(this.storagePath, 'utf8')) as
      | PersistedRegistry
      | SyncAgent[];
    if (Array.isArray(raw)) {
      return { agents: raw, updatedAt: nowIso() };
    }
    return { agents: raw.agents ?? [], updatedAt: raw.updatedAt ?? nowIso() };
  }

  private write(agents: SyncAgent[]): void {
    mkdirSync(dirname(this.storagePath), { recursive: true });
    const payload: PersistedRegistry = {
      agents,
      updatedAt: nowIso(),
    };
    writeFileSync(this.storagePath, JSON.stringify(payload, null, 2), 'utf8');
  }
}
