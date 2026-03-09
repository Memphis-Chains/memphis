import { describe, expect, it } from 'vitest';
import { runImportJsonPayload } from '../../src/infra/cli/import-json.js';

describe('import_json migration semantics', () => {
  it('supports legacy {chain:[...]} payload and reconciles index/links', () => {
    const result = runImportJsonPayload({
      chain: [
        { idx: 10, prevHash: 'bad', hash: 'h0', content: 'a' },
        { idx: 22, prevHash: 'wrong', hash: 'h1', content: 'b' },
      ],
    });

    expect(result.imported).toBe(2);
    expect(result.source.shape).toBe('legacy.chain');
    expect(result.reconciliation.indexRewritten).toBe(2);
    expect(result.reconciliation.prevHashRewritten).toBe(2);
    expect(result.blocks[0]).toMatchObject({ index: 0, prev_hash: '0'.repeat(64), hash: 'h0' });
    expect(result.blocks[1]).toMatchObject({ index: 1, prev_hash: 'h0', hash: 'h1' });
  });

  it('applies idempotent duplicate-by-hash skip policy', () => {
    const result = runImportJsonPayload([
      { index: 0, prev_hash: '0'.repeat(64), hash: 'same' },
      { index: 1, prev_hash: 'same', hash: 'same' },
    ]);

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.reconciliation.duplicatesSkipped).toBe(1);
    expect(result.policy.idempotentKey).toBe('hash');
  });

  it('supports object {blocks:[...]} payload', () => {
    const result = runImportJsonPayload({
      blocks: [
        { index: 0, prev_hash: '0'.repeat(64), hash: 'h0' },
        { index: 1, prev_hash: 'h0', hash: 'h1' },
      ],
    });

    expect(result.valid).toBe(true);
    expect(result.source.shape).toBe('object.blocks');
  });
});
