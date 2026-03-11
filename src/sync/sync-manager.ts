import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Block } from '../memory/chain.js';
import { detectChainDiff } from './chain-diff.js';
import { resolveChainConflicts, type ConflictResolutionStrategy } from './conflict-resolver.js';
import { SyncAgentRegistry } from './agent-registry.js';
import { SyncProtocol } from './protocol.js';

export type SyncStatus = {
  chain: string;
  localBlocks: number;
  agentsKnown: number;
  agentsOnline: number;
  updatedAt: string;
};

export class SyncManager {
  constructor(
    private readonly ownDid: string,
    private readonly registry = new SyncAgentRegistry(),
    private readonly protocol = new SyncProtocol(ownDid),
  ) {}

  status(chain: string): SyncStatus {
    const local = this.readChain(chain);
    const agents = this.registry.list();
    const online = agents.filter((agent) => agent.status === 'online').length;
    return {
      chain,
      localBlocks: local.length,
      agentsKnown: agents.length,
      agentsOnline: online,
      updatedAt: new Date().toISOString(),
    };
  }

  discoverAgents() {
    return this.registry.discover();
  }

  listAgents() {
    return this.registry.list();
  }

  async push(chain: string): Promise<{ chain: string; pushedTo: number; failures: Array<{ did: string; error: string }> }> {
    const blocks = this.readChain(chain);
    const agents = this.registry.list();
    const failures: Array<{ did: string; error: string }> = [];
    let pushedTo = 0;

    for (const agent of agents) {
      try {
        await this.protocol.sendRequest(agent.endpoint, 'sync.push', { chain, blocks }, 2500);
        this.registry.upsert({ ...agent, status: 'online' });
        pushedTo += 1;
      } catch (error) {
        this.registry.upsert({ ...agent, status: 'offline' });
        failures.push({ did: agent.did, error: error instanceof Error ? error.message : String(error) });
      }
    }

    return { chain, pushedTo, failures };
  }

  async pull(agentDid: string, chain = 'journal', strategy: ConflictResolutionStrategy = 'last-write-wins') {
    const agent = this.registry.get(agentDid);
    if (!agent) throw new Error(`agent not found in registry: ${agentDid}`);

    const response = await this.protocol.sendRequest<{ chain: string }, { chain: string; blocks: Block[] }>(
      agent.endpoint,
      'sync.pull',
      { chain },
      3000,
    );

    const remoteBlocks = response.payload.blocks ?? [];
    const localBlocks = this.readChain(chain);
    const diff = detectChainDiff(localBlocks, remoteBlocks);
    const merged = resolveChainConflicts({ local: localBlocks, remote: remoteBlocks, strategy });
    this.writeChain(chain, merged);
    this.registry.upsert({ ...agent, status: 'online' });

    return {
      chain,
      agent: agentDid,
      before: localBlocks.length,
      after: merged.length,
      diff: {
        localOnly: diff.localOnly.length,
        remoteOnly: diff.remoteOnly.length,
        conflicts: diff.conflicts.length,
      },
    };
  }

  private chainPath(chain: string): string {
    return resolve(`data/chains/${chain}.json`);
  }

  private readChain(chain: string): Block[] {
    const path = this.chainPath(chain);
    if (!existsSync(path)) return [];

    const raw = JSON.parse(readFileSync(path, 'utf8')) as Block[] | { blocks?: Block[] };
    if (Array.isArray(raw)) return raw;
    return raw.blocks ?? [];
  }

  private writeChain(chain: string, blocks: Block[]): void {
    const path = this.chainPath(chain);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(blocks, null, 2), 'utf8');
  }
}
