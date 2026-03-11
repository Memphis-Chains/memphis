import type { Block } from '../../../memory/chain.js';
import { getRecentBlocks } from '../../storage/rust-chain-adapter.js';

export async function loadCognitiveBlocks(): Promise<Block[]> {
  const [journal, decisions] = await Promise.all([getRecentBlocks('journal', 120), getRecentBlocks('decision', 120)]);
  return [...journal, ...decisions].sort((a, b) => {
    const ta = new Date(a.timestamp ?? 0).getTime();
    const tb = new Date(b.timestamp ?? 0).getTime();
    return ta - tb;
  });
}
