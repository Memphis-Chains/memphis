import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { verifyChainIntegrity } from '../../src/infra/storage/chain-adapter.js';

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
    }
  }));
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});
function child(code: string, root: string, rust = 'false') {
  const process = spawn(globalThis.process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    env: { ...globalThis.process.env, MEMPHIS_DATA_DIR: root, RUST_CHAIN_ENABLED: rust },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(process);
  return process;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'memphis-writers-')); roots.push(root); return root;
}

it('preserves every append across concurrent TS and NAPI processes', async () => {
  const root = fixture();
  const workers = Array.from({ length: 4 }, (_, worker) => child(`
    import { appendBlock } from './src/infra/storage/chain-adapter.ts';
    for (let i = 0; i < 8; i++) await appendBlock('journal', { type: 'journal', content: '${worker}:' + i }, process.env);
  `, root, worker % 2 === 0 ? 'true' : 'false'));
  const statuses = await Promise.all(workers.map(async (worker) => {
    let error = ''; worker.stderr!.on('data', (data) => { error += data; });
    const [code] = await once(worker, 'close'); return { code, error };
  }));
  expect(statuses).toEqual(statuses.map(() => ({ code: 0, error: '' })));
  expect(await verifyChainIntegrity('journal', { MEMPHIS_DATA_DIR: root })).toMatchObject({ ok: true, blockCount: 32 });
  const directory = join(root, 'chains', 'journal');
  const blocks = readdirSync(directory).filter((file) => file.endsWith('.json')).map((file) => JSON.parse(readFileSync(join(directory, file), 'utf8')));
  expect(new Set(blocks.map((block) => block.data.content)).size).toBe(32);
  expect(readdirSync(directory).every((file) => file.endsWith('.json'))).toBe(true);
}, 30_000);

it('releases the writer lock after SIGKILL without a stale lease delay', async () => {
  const root = fixture();
  const holder = child(`
    import { withChainWriteLock } from './src/infra/storage/chain-write-lock.ts';
    await withChainWriteLock(process.env.MEMPHIS_DATA_DIR + '/chains/journal', async () => {
      console.log('locked'); await new Promise(() => { setInterval(() => {}, 1000); });
    });
  `, root);
  await once(holder.stdout!, 'data');
  const closed = once(holder, 'close'); holder.kill('SIGKILL'); await closed;
  const writer = child(`
    import { appendBlock } from './src/infra/storage/chain-adapter.ts';
    await appendBlock('journal', { type: 'note', content: 'after-crash' }, process.env);
  `, root);
  const [status] = await once(writer, 'close');
  expect(status).toBe(0);
  expect(await verifyChainIntegrity('journal', { MEMPHIS_DATA_DIR: root })).toMatchObject({ ok: true, blockCount: 1 });
}, 15_000);
