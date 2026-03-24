import { SyncAgentRegistry } from './agent-registry.js';
import { detectChainDiff } from './chain-diff.js';
import { ConflictResolutionStrategy, resolveChainConflicts } from './conflict-resolver.js';
import { SyncProtocol } from './protocol.js';
import { appendBlock, resolveChainDir } from '../infra/storage/chain-adapter.js';
import type { Block } from '../memory/chain.js';

export type SyncStatus = {
  chain: string;
  localBlocks: number;
  agentsKnown: number;
  agentsOnline: number;
  updatedAt: string;
};

interface ChainBlock {
  index: number;
  timestamp: string;
  chain: string;
  data: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

export class SyncManager {
  constructor(
    private readonly ownDid: string,
    private readonly registry = new SyncAgentRegistry(),
    private readonly protocol = new SyncProtocol(ownDid),
  ) {}

  async status(chain: string): Promise<SyncStatus> {
    const local = await this.readChain(chain);
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

  async push(
    chain: string,
  ): Promise<{ chain: string; pushedTo: number; failures: Array<{ did: string; error: string }> }> {
    const blocks = await this.readChain(chain);
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
        failures.push({
          did: agent.did,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { chain, pushedTo, failures };
  }

  async pull(
    agentDid: string,
    chain = 'journal',
    strategy: ConflictResolutionStrategy = 'last-write-wins',
  ) {
    const agent = this.registry.get(agentDid);
    if (!agent) throw new Error(`agent not found in registry: ${agentDid}`);

    const response = await this.protocol.sendRequest<
      { chain: string },
      { chain: string; blocks: Block[] }
    >(agent.endpoint, 'sync.pull', { chain }, 3000);

    const remoteBlocks = response.payload.blocks ?? [];
    const localBlocks = await this.readChain(chain);
    const diff = detectChainDiff(localBlocks, remoteBlocks);
    const merged = resolveChainConflicts({ local: localBlocks, remote: remoteBlocks, strategy });
    await this.writeChain(chain, merged);
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

  private async readChain(chain: string): Promise<Block[]> {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const os = await import('node:os');

    let chainsDir: string;
    try {
      chainsDir = resolveChainDir(chain, {
        homedir: os.homedir(),
        resolve: path.resolve,
        sep: path.sep,
      });
    } catch {
      // Chain directory doesn't exist yet
      return [];
    }

    let files: string[];
    try {
      files = (await fs.readdir(chainsDir)).filter((f) => f.endsWith('.json')).sort();
    } catch {
      return [];
    }

    if (files.length === 0) {
      return [];
    }

    // Check if this is the legacy flat JSON file format
    const legacyPath = path.join(chainsDir, `${chain}.json`);
    try {
      const stats = await fs.stat(legacyPath);
      if (stats.isFile()) {
        // Legacy flat JSON format - read and convert
        const raw = await fs.readFile(legacyPath, 'utf8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          return this.chainBlocksToBlocks(parsed as ChainBlock[]);
        }
      }
    } catch {
      // Not legacy format or doesn't exist
    }

    // Per-block numbered files
    const indexed = files
      .map((file) => ({ file, index: Number.parseInt(file.replace('.json', ''), 10) }))
      .filter((entry) => Number.isFinite(entry.index))
      .sort((a, b) => a.index - b.index);

    const blocks: ChainBlock[] = [];
    for (const entry of indexed) {
      const raw = await fs.readFile(path.join(chainsDir, entry.file), 'utf8');
      const parsed = JSON.parse(raw) as Partial<ChainBlock>;
      if (
        typeof parsed.index === 'number' &&
        typeof parsed.timestamp === 'string' &&
        typeof parsed.chain === 'string' &&
        typeof parsed.prev_hash === 'string' &&
        typeof parsed.hash === 'string' &&
        typeof parsed.data === 'object' &&
        parsed.data !== null
      ) {
        blocks.push(parsed as ChainBlock);
      }
    }

    return this.chainBlocksToBlocks(blocks);
  }

  private async writeChain(chain: string, blocks: Block[]): Promise<void> {
    for (const block of blocks) {
      // Convert Block to the format expected by appendBlock
      const data: Record<string, unknown> = {
        ...block.data,
        _index: block.index,
        _timestamp: block.timestamp,
        _hash: block.hash,
        _chain: block.chain,
      };

      await appendBlock(chain, data);

      // Clean up the temporary fields we added
      delete data._index;
      delete data._timestamp;
      delete data._hash;
      delete data._chain;
    }
  }

  private chainBlocksToBlocks(chainBlocks: ChainBlock[]): Block[] {
    return chainBlocks.map((cb) => {
      const data = cb.data as Record<string, unknown>;
      const block: Block = {
        index: cb.index,
        timestamp: cb.timestamp,
        hash: cb.hash,
        chain: cb.chain,
        data: {
          content: typeof data.content === 'string' ? data.content : JSON.stringify(data),
          tags: Array.isArray(data.tags) ? data.tags : [],
          ...data,
        },
      };
      return block;
    });
  }
}
