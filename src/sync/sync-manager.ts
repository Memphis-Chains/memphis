import * as fsP from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

import { SyncAgentRegistry } from './agent-registry.js';
import { detectChainDiff } from './chain-diff.js';
import { ConflictResolutionStrategy, resolveChainConflicts } from './conflict-resolver.js';
import { SyncProtocol } from './protocol.js';
import { appendPrecomputedBlock, resolveChainDir, withAppendLock } from '../infra/storage/chain-adapter.js';
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
  signer?: string;
  signature?: string;
}

export class SyncManager {
  private readonly seenEnvelopeIds = new Set<string>();
  private readonly SEEN_IDS_MAX_SIZE = 10_000;

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

  /**
   * EC4: Handle an incoming envelope with deduplication.
   * Returns true if the envelope was processed, false if it was a duplicate.
   */
  handleIncomingEnvelope(envelope: { id: string }): boolean {
    if (this.seenEnvelopeIds.has(envelope.id)) {
      return false; // duplicate — drop
    }
    this.seenEnvelopeIds.add(envelope.id);
    // Bounded store — evict oldest when full
    if (this.seenEnvelopeIds.size > this.SEEN_IDS_MAX_SIZE) {
      const first = this.seenEnvelopeIds.values().next().value;
      if (first !== undefined) {
        this.seenEnvelopeIds.delete(first);
      }
    }
    return true;
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
    const chainsDir = resolveChainDir(chain, {
      homedir: homedir(),
      resolve: path.resolve,
      sep: path.sep,
    });

    // Import lazily so the sync manager doesn't force the Rust bridge
    // to load just for status queries that never hit writeChain.
    const { verifyChainBlockSignature } = await import('./signature-verify.js');
    const acceptUnsigned =
      (process.env.MEMPHIS_SYNC_ACCEPT_UNSIGNED ?? '').toLowerCase() === 'true';

    await withAppendLock(chainsDir, fsP, path, async () => {
      for (const block of blocks) {
        if (block.index === undefined || block.timestamp === undefined || block.hash === undefined) {
          throw new Error('cannot write block with missing index/timestamp/hash');
        }

        // #142 — signature check on remote-origin blocks. The TS sync
        // path used to accept anything the peer returned because no
        // verify_block_signature call existed here. Now we require a
        // verified signature on every block, unless the operator
        // explicitly opts in to MEMPHIS_SYNC_ACCEPT_UNSIGNED (for
        // legacy migration — logged loudly by the verifier).
        const hasSig =
          typeof block.signer === 'string' && typeof block.signature === 'string';
        if (!hasSig) {
          if (!acceptUnsigned) {
            throw new Error(
              `refusing to accept unsigned peer block (chain=${chain}, index=${String(
                block.index,
              )}): set MEMPHIS_SYNC_ACCEPT_UNSIGNED=true to opt in`,
            );
          }
        } else {
          const valid = await verifyChainBlockSignature(block);
          if (!valid) {
            throw new Error(
              `refusing peer block with invalid signature (chain=${chain}, index=${String(
                block.index,
              )}, signer=${block.signer ?? '<none>'})`,
            );
          }
        }

        await appendPrecomputedBlock(chain, {
          index: block.index,
          timestamp: block.timestamp,
          hash: block.hash,
          prev_hash: '', // not used when appending precomputed blocks
          data: block.data ?? {},
          ...(block.signer !== undefined ? { signer: block.signer } : {}),
          ...(block.signature !== undefined ? { signature: block.signature } : {}),
        });
      }
    });
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
