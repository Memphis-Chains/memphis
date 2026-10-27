/** Compare offline Python fixtures to the real Node tokenizer and ONNX loader. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PreTrainedTokenizer } from '@huggingface/transformers';

import { sha256Hex, signCheckpoint } from '../../src/kartograf/checkpoint.js';
import { KARTOGRAF_TOKENIZER_CONFIG } from '../../src/kartograf/embedding-space.js';
import { OnnxKartografSession } from '../../src/kartograf/onnx-session.js';
import { kartografTokenIds } from '../../src/kartograf/tokenizer.js';
import { KARTOGRAF_V1_ZONE_LABELS } from '../../src/kartograf/zone-labels.js';

const [fixtureArg, tokenizerArg] = process.argv.slice(2);
assert(
  fixtureArg && tokenizerArg,
  'Usage: tsx check-preflight-runtime.ts FIXTURE_DIR TOKENIZER_DIR',
);
const fixture = resolve(fixtureArg);
const tokenizerBytes = readFileSync(join(resolve(tokenizerArg), 'tokenizer.json'));
const tokenizer = new PreTrainedTokenizer(JSON.parse(tokenizerBytes.toString()), {
  ...KARTOGRAF_TOKENIZER_CONFIG,
});
const cases = JSON.parse(readFileSync(join(fixture, 'python-tokenizer-cases.json'), 'utf8')) as {
  text: string;
  input_ids: number[];
  attention_mask: number[];
  embedding: number[];
  zone_logits: number[];
}[];
const native = join(fixture, 'node-native-fixture');
mkdirSync(native, { mode: 0o700 });
const graph = readFileSync(join(fixture, 'tiny-model.onnx'));
const envelope = signCheckpoint(
  {
    version: 'kartograf-v1',
    base_model: 'synthetic-random-ModernBERT@fixture',
    onnx_sha256: sha256Hex(graph),
    tokenizer_sha256: sha256Hex(tokenizerBytes),
    heads_config: { embedding_dim: 256, zone_classes: 12, multitask_alpha: 0.5 },
    training_provenance: {
      trained_at: new Date().toISOString(),
      corpus_version: 'synthetic-fixture-only',
      hardware: 'preflight',
      eval_recall_at_10: 0,
      steps: 1,
    },
    distribution_source: 'file',
  },
  randomBytes(32),
);
copyFileSync(join(fixture, 'tiny-model.onnx'), join(native, 'model.onnx'));
writeFileSync(join(native, 'tokenizer.json'), tokenizerBytes);
writeFileSync(join(native, 'checkpoint.json'), JSON.stringify(envelope));
const session = await OnnxKartografSession.load(join(native, 'checkpoint.json'));
let maxEmbeddingGap = 0;
let maxZoneGap = 0;
try {
  for (const c of cases) {
    assert.deepEqual(kartografTokenIds(tokenizer, c.text), c.input_ids);
    assert.deepEqual(
      c.attention_mask,
      c.input_ids.map(() => 1),
    );
    const output = await session.embed(c.text);
    assert.equal(output.embeddingSpaceId, session.embeddingSpace.id);
    maxEmbeddingGap = Math.max(
      maxEmbeddingGap,
      ...output.embedding.map((v, i) => Math.abs(v - c.embedding[i])),
    );
    const maxLogit = Math.max(...c.zone_logits);
    const exp = c.zone_logits.map((v) => Math.exp(v - maxLogit));
    const total = exp.reduce((sum, v) => sum + v, 0);
    for (const zone of output.zones) {
      const i = KARTOGRAF_V1_ZONE_LABELS.indexOf(zone.zone);
      maxZoneGap = Math.max(maxZoneGap, Math.abs(zone.score - exp[i] / total));
    }
  }
  assert(maxEmbeddingGap < 1e-4 && maxZoneGap < 1e-4);
  const report = {
    fixtureOnly: true,
    passed: true,
    cases: cases.length,
    tokenCounts: cases.map((c) => c.input_ids.length),
    maxEmbeddingGap,
    maxZoneGap,
    embeddingSpace: session.embeddingSpace,
  };
  writeFileSync(join(fixture, 'node-runtime-parity.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await session.close();
}
