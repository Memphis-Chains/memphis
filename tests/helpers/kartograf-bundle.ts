import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sha256Hex, signCheckpoint } from '../../src/kartograf/checkpoint.js';

/** Tiny tokenizer fixture: no downloaded weights, no semantic quality claim. */
export function kartografBundleFixture() {
  const root = mkdtempSync(join(tmpdir(), 'kartograf-contract-'));
  const tokenizer = {
    version: '1.0',
    truncation: null,
    padding: null,
    added_tokens: ['[UNK]', '[CLS]', '[SEP]', '[PAD]'].map((content, id) => ({
      id,
      content,
      single_word: false,
      lstrip: false,
      rstrip: false,
      normalized: false,
      special: true,
    })),
    normalizer: {
      type: 'BertNormalizer',
      clean_text: true,
      handle_chinese_chars: true,
      strip_accents: null,
      lowercase: true,
    },
    pre_tokenizer: { type: 'BertPreTokenizer' },
    post_processor: {
      type: 'TemplateProcessing',
      single: [
        { SpecialToken: { id: '[CLS]', type_id: 0 } },
        { Sequence: { id: 'A', type_id: 0 } },
        { SpecialToken: { id: '[SEP]', type_id: 0 } },
      ],
      pair: [
        { SpecialToken: { id: '[CLS]', type_id: 0 } },
        { Sequence: { id: 'A', type_id: 0 } },
        { SpecialToken: { id: '[SEP]', type_id: 0 } },
        { Sequence: { id: 'B', type_id: 1 } },
        { SpecialToken: { id: '[SEP]', type_id: 1 } },
      ],
      special_tokens: {
        '[CLS]': { id: '[CLS]', ids: [1], tokens: ['[CLS]'] },
        '[SEP]': { id: '[SEP]', ids: [2], tokens: ['[SEP]'] },
      },
    },
    decoder: { type: 'WordPiece', prefix: '##', cleanup: true },
    model: {
      type: 'WordPiece',
      unk_token: '[UNK]',
      continuing_subword_prefix: '##',
      max_input_chars_per_word: 100,
      vocab: { '[UNK]': 0, '[CLS]': 1, '[SEP]': 2, '[PAD]': 3, hello: 4, world: 5, '!': 6 },
    },
  };
  const model = Buffer.from('synthetic graph fixture; native inference is mocked');
  const tokens = JSON.stringify(tokenizer);
  const envelope = signCheckpoint(
    {
      version: 'kartograf-v1',
      base_model: 'synthetic@revision',
      onnx_sha256: sha256Hex(model),
      tokenizer_sha256: sha256Hex(tokens),
      heads_config: { embedding_dim: 2, zone_classes: 12, multitask_alpha: 0.7 },
      training_provenance: {
        trained_at: '2026-10-27T00:00:00Z',
        corpus_version: 'synthetic',
        hardware: 'test',
        eval_recall_at_10: 0,
        steps: 1,
      },
      distribution_source: 'file',
    },
    randomBytes(32),
  );
  const path = join(root, 'checkpoint.json');
  writeFileSync(path, JSON.stringify(envelope));
  writeFileSync(join(root, 'model.onnx'), model);
  writeFileSync(join(root, 'tokenizer.json'), tokens);
  return { root, path, envelope, tokenizer };
}
