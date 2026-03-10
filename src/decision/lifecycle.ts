import { createHash } from 'node:crypto';
import { DecisionValidator, type Decision } from './validator.js';

export class DecisionLifecycle {
  private readonly seen = new Set<string>();
  private readonly validator = new DecisionValidator();

  async create(input: { question: string; choice: string; reasoning: string; tags?: string[] }): Promise<Decision & { hash: string; timestamp: string; chainRef: { chain: string; index: number } }> {
    const key = `${input.question}::${input.choice}::${input.reasoning}`;
    if (this.seen.has(key)) throw new Error('Duplicate decision');

    const timestamp = new Date().toISOString();
    const hash = createHash('sha256').update(key).digest('hex');
    const decision = {
      ...input,
      hash,
      timestamp,
      chainRef: { chain: 'decisions', index: this.seen.size },
    };

    this.validator.validateForChain(decision);
    this.seen.add(key);
    return decision;
  }
}
