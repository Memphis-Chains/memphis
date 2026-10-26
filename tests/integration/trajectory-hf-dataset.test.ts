import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { appendBlock, exportChain } from '../../src/infra/storage/chain-adapter.js';
import { exportTrajectories } from '../../src/trajectory/exporter.js';
import { writeHfTrajectoryDataset } from '../../src/trajectory/hf-dataset.js';

it('writes uniform dataset rows while preserving consent filtering, nested events and provenance', async () => {
  const root = mkdtempSync(join(tmpdir(), 'memphis-hf-trajectories-'));
  const env = {
    ...process.env,
    MEMPHIS_DATA_DIR: join(root, 'runtime'),
    RUST_CHAIN_ENABLED: 'false',
  };
  await appendBlock(
    'journal',
    {
      type: 'journal',
      content: 'public synthetic event',
      conversation_id: 'one',
      consent: 'exportable',
      detail: { value: 4 },
    },
    env,
  );
  await appendBlock(
    'journal',
    {
      type: 'journal',
      content: 'private synthetic event',
      conversation_id: 'one',
      consent: 'local-only',
    },
    env,
  );
  const blocks = (await exportChain('journal', env)).blocks;
  const result = await exportTrajectories({
    chains: ['journal'],
    rawEnv: env,
    query: async ({ chain }) => ({ chain: chain!, count: blocks.length, blocks }),
  });
  const target = join(root, 'dataset');
  const files = await writeHfTrajectoryDataset(target, result);
  expect(files).toEqual(['data/train.jsonl']);
  const row = JSON.parse(readFileSync(join(target, files[0]), 'utf8'));
  expect(JSON.parse(row.events_json)).toEqual(result.trajectories[0].events);
  expect(JSON.parse(row.integrity_json)).toEqual(result.trajectories[0].integrity);
  expect(row.events_json).toContain('public synthetic event');
  expect(row.events_json).not.toContain('private synthetic event');
  expect(result.summary.filteredByConsent).toBe(1);
  expect(readFileSync(join(target, 'README.md'), 'utf8')).toContain('path: data/train.jsonl');
  await expect(writeHfTrajectoryDataset(target, result)).rejects.toMatchObject({ code: 'EEXIST' });
});
