import { describe, expect, it } from 'vitest';

import {
  normalizeCaseQueryForToolCall,
  normalizeSoulWriteUpdatesForToolCall,
  optionalIntegerInRange,
  requiredString,
} from '../../src/gateway/tool-executor/input-normalization.js';

describe('tool executor input normalization', () => {
  it('normalizes numeric case limits without mutating the caller object', () => {
    const input = { limit: ' 12 ', query: 'needle' };
    expect(normalizeCaseQueryForToolCall(input)).toEqual({ limit: 12, query: 'needle' });
    expect(input.limit).toBe(' 12 ');
  });

  it('normalizes object-shaped soul arrays in stable numeric order', () => {
    expect(
      normalizeSoulWriteUpdatesForToolCall({
        user: { languages: { 1: 'Polish', 0: 'English' } },
      }),
    ).toEqual({ user: { languages: ['English', 'Polish'] } });
  });

  it('keeps common validation failures fail-closed', () => {
    expect(() => requiredString({}, 'query')).toThrow('must be a non-empty string');
    expect(() => optionalIntegerInRange({ limit: 51 }, 'limit', 1, 50)).toThrow('between 1 and 50');
  });
});
