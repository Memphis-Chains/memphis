import { createHash } from 'node:crypto';

import { Decision, DecisionValidator } from './validator.js';
import { ChainStore, IStore } from '../cognitive/store.js';

export class DecisionLifecycle {
  private readonly seen = new Set<string>();
  private readonly validator = new DecisionValidator();
  private readonly store: IStore;

  constructor(store: IStore = new ChainStore()) {
    this.store = store;
  }

  async create(input: {
    question: string;
    choice: string;
    reasoning: string;
    tags?: string[];
  }): Promise<
    Decision & { hash: string; timestamp: string; chainRef: { chain: string; index: number } }
  > {
    const key = `${input.question}::${input.choice}::${input.reasoning}`;
    if (this.seen.has(key)) throw new Error('Duplicate decision');

    const timestamp = new Date().toISOString();
    const hash = createHash('sha256').update(key).digest('hex');
    const decision = {
      ...input,
      type: 'decision',
      hash,
      timestamp,
      chainRef: { chain: 'decisions', index: 0 },
    };

    this.validator.validateForChain(decision);
    const saved = await this.store.append('decisions', decision);
    this.seen.add(key);
    return {
      ...decision,
      chainRef: { chain: saved.chain, index: saved.index },
    };
  }
}
