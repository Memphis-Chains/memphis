import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getTensorStatus } from '../../src/infra/tensors/status.js';

describe('tensor status', () => {
  it('reports memory embeddings and Kartograf as separate tensor surfaces', () => {
    const out = getTensorStatus({
      RUST_CHAIN_ENABLED: 'false',
      RUST_EMBED_DIM: '32',
      RUST_EMBED_MODE: 'local',
      RUST_EMBED_PERSIST_ENABLED: 'true',
      MEMPHIS_KARTOGRAF_ENABLE: '0',
    } as NodeJS.ProcessEnv);

    expect(out.memoryEmbedding.configured.dim).toBe(32);
    expect(out.memoryEmbedding.configured.dtype).toBe('f32');
    expect(out.memoryEmbedding.truthRole).toBe('derived-recall-index');
    expect(out.memoryEmbedding.configured.persistenceEnabled).toBe(true);
    expect(out.memoryEmbedding.runtime.persistenceEnabled).toBe('unknown');
    expect(out.memoryEmbedding.meta.kind).toBe('memory_embedding');
    expect(out.memoryEmbedding.meta.exposeRawValues).toBe(false);
    expect(out.kartograf.mode).toBe('stub');
    expect(out.kartograf.dim).toBe(256);
    expect(out.surfacePolicy.exposeRawValues).toBe(false);
  });

  it('flags legacy persisted index dimensions without reading raw vectors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-tensor-status-'));
    const indexPath = join(dir, 'index-v1.json');
    writeFileSync(indexPath, JSON.stringify({ dim: 768, docs: [] }), 'utf8');

    const out = getTensorStatus({
      RUST_CHAIN_ENABLED: 'false',
      RUST_EMBED_DIM: '32',
      RUST_EMBED_PERSIST_PATH: indexPath,
    } as NodeJS.ProcessEnv);

    expect(out.memoryEmbedding.configured.legacyDimMismatch).toBe(true);
  });

  it('defaults configured embedding persistence to enabled', () => {
    const out = getTensorStatus({
      RUST_CHAIN_ENABLED: 'false',
    } as NodeJS.ProcessEnv);

    expect(out.memoryEmbedding.configured.persistenceEnabled).toBe(true);
    expect(out.memoryEmbedding.meta.persistenceEnabled).toBe(true);
  });

  it('keeps explicit embedding persistence opt-out', () => {
    const out = getTensorStatus({
      RUST_CHAIN_ENABLED: 'false',
      RUST_EMBED_PERSIST_ENABLED: 'false',
    } as NodeJS.ProcessEnv);

    expect(out.memoryEmbedding.configured.persistenceEnabled).toBe(false);
    expect(out.memoryEmbedding.meta.persistenceEnabled).toBe(false);
  });
});
