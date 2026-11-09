import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { updateSoulMemory } from '../../src/soul/memory.js';

describe('cross-process soul memory updates', () => {
  it('refuses a legacy lock or a symlinked SQLite lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-memory-lock-'));
    const config = join(dir, 'config');
    mkdirSync(config);
    const env = { MEMPHIS_DATA_DIR: dir };
    mkdirSync(join(config, 'soul-memory.json.lock'));
    expect(() => updateSoulMemory({ self: { learnings: ['legacy'] } }, env)).toThrow('legacy soul-memory lock');
    const other = mkdtempSync(join(tmpdir(), 'memphis-memory-link-'));
    mkdirSync(join(other, 'config'));
    symlinkSync(join(dir, 'target'), join(other, 'config', 'soul-memory.json.lock.sqlite'));
    expect(() => updateSoulMemory({ self: { learnings: ['link'] } }, { MEMPHIS_DATA_DIR: other })).toThrow('unsafe soul-memory lock');
  });
  it('retains each concurrent update instead of accepting lost writes', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'memphis-memory-race-'));
    const worker = `import {updateSoulMemory} from './src/soul/memory.ts';
      process.send('ready'); process.once('message', () => {
        updateSoulMemory({self:{learnings:[process.argv[1]]}}); process.disconnect();
      });`;
    const children = Array.from({ length: 8 }, (_, index) => {
      return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', worker, `writer-${index}`], {
        cwd: process.cwd(),
        env: { PATH: process.env.PATH, HOME: dataDir, MEMPHIS_DATA_DIR: dataDir, NODE_ENV: 'test',
          RUST_CHAIN_BRIDGE_PATH: process.env.MEMPHIS_TEST_NATIVE_BRIDGE },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      });
    });
    const ready = children.map((child, index) => new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('error', reject);
      child.once('close', (code) => reject(new Error(`writer ${index} exited before barrier: ${code}`)));
    }));
    const done = children.map((child, index) => new Promise<void>((resolve, reject) => {
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`writer ${index} exited ${code}: ${stderr}`)));
    }));
    await Promise.all(ready);
    children.forEach((child) => child.send('go'));
    await Promise.all(done);
    const memory = JSON.parse(readFileSync(join(dataDir, 'config', 'soul-memory.json'), 'utf8')) as { self: { learnings: string[] } };
    expect(memory.self.learnings.sort()).toEqual(Array.from({ length: 8 }, (_, i) => `writer-${i}`));
  }, 30_000);
});
