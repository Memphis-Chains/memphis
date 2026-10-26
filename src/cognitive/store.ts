import { AppendBlockResult, appendBlock } from '../infra/storage/chain-adapter.js';

export interface IStore {
  getEnvironment?(): NodeJS.ProcessEnv;
  /**
   * Appends a block payload to the specified chain.
   */
  append(chain: string, data: Record<string, unknown>): Promise<AppendBlockResult>;
}

export class ChainStore implements IStore {
  readonly #rawEnv?: NodeJS.ProcessEnv;

  constructor(rawEnv?: NodeJS.ProcessEnv) {
    this.#rawEnv = rawEnv ? { ...rawEnv } : undefined;
  }

  getEnvironment(): NodeJS.ProcessEnv {
    return this.#rawEnv ? { ...this.#rawEnv } : process.env;
  }
  /**
   * Appends a block payload to the specified chain using the default environment.
   */
  async append(chain: string, data: Record<string, unknown>): Promise<AppendBlockResult> {
    return appendBlock(chain, data, this.getEnvironment());
  }
}
