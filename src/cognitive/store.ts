import { AppendBlockResult, appendBlock } from '../infra/storage/chain-adapter.js';

export interface IStore {
  /**
   * Appends a block payload to the specified chain.
   */
  append(chain: string, data: Record<string, unknown>): Promise<AppendBlockResult>;
}

export class ChainStore implements IStore {
  /**
   * Appends a block payload to the specified chain using the default environment.
   */
  async append(chain: string, data: Record<string, unknown>): Promise<AppendBlockResult> {
    return appendBlock(chain, data, process.env);
  }
}
