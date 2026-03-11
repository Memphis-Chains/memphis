import { appendBlock, type AppendBlockResult } from '../infra/storage/chain-adapter.js';

export interface IStore {
  append(chain: string, data: Record<string, unknown>): Promise<AppendBlockResult>;
}

export class ChainStore implements IStore {
  async append(chain: string, data: Record<string, unknown>): Promise<AppendBlockResult> {
    return appendBlock(chain, data, process.env);
  }
}
