import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Block } from '../../memory/chain.js';

export async function getRecentBlocks(chain = 'journal', limit = 20): Promise<Block[]> {
  const dir = join(homedir(), '.memphis', 'chains', chain);
  try {
    const files = (await readdir(dir))
      .filter((f) => f.endsWith('.json'))
      .sort();

    const recent = files.slice(-Math.max(1, limit));
    const blocks = await Promise.all(
      recent.map(async (file) => {
        const raw = await readFile(join(dir, file), 'utf8');
        return JSON.parse(raw) as Block;
      }),
    );

    return blocks;
  } catch {
    return [];
  }
}
