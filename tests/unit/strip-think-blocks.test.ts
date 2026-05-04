/**
 * Strip <think> reasoning blocks before reply hits surfaces.
 *
 * Operator session 2026-05-04 hit visible "<think>The user is asking..."
 * preambles in Telegram messages. Cogito, qwen-thinking, deepseek-r1
 * and similar reasoning-mode models all emit these blocks; great as a
 * dev trace, ugly in chat. Pin the gateway-side strip contract.
 */
import { describe, expect, it } from 'vitest';

import { stripThinkBlocks } from '../../src/gateway/turn-runtime.js';

describe('stripThinkBlocks', () => {
  it('removes a single closed <think> block', () => {
    const out = stripThinkBlocks('<think>internal reasoning</think>actual reply', {});
    expect(out).toBe('actual reply');
  });

  it('removes a multi-line <think> block', () => {
    const input = `<think>
The user is asking X.
Let me think...
Step 1, step 2.
</think>

## Real reply
Body.`;
    const out = stripThinkBlocks(input, {});
    expect(out).toContain('## Real reply');
    expect(out).toContain('Body.');
    expect(out).not.toContain('internal');
    expect(out).not.toContain('Step 1');
    expect(out).not.toMatch(/<\/?think>/);
  });

  it('removes multiple <think> blocks', () => {
    const out = stripThinkBlocks(
      '<think>first</think>part one<think>second</think>part two',
      {},
    );
    expect(out).toBe('part onepart two');
  });

  it('handles uppercase/mixed-case <THINK>', () => {
    expect(stripThinkBlocks('<THINK>x</THINK>visible', {})).toBe('visible');
    expect(stripThinkBlocks('<Think>x</Think>visible', {})).toBe('visible');
  });

  it('handles attributes on the <think> tag', () => {
    expect(stripThinkBlocks('<think class="reason">x</think>body', {})).toBe('body');
  });

  it('strips a trailing UNCLOSED <think> block (model started thinking, never closed)', () => {
    const input = 'visible reply\n<think>partial reasoning that never closed';
    const out = stripThinkBlocks(input, {});
    expect(out).toBe('visible reply');
  });

  it('preserves non-<think> markup verbatim', () => {
    const input = '## Heading\n\n```ts\nconst x = 1;\n```\n\nText.';
    expect(stripThinkBlocks(input, {})).toBe(input);
  });

  it('returns empty string if the whole reply is <think>', () => {
    // Pathological case: the model emitted only reasoning. We strip to
    // empty and leave the empty-reply guard at the channel boundary
    // (Telegram already handles "(brak odpowiedzi — spróbuj ponownie)").
    expect(stripThinkBlocks('<think>just thinking</think>', {})).toBe('');
  });

  it('passes output through verbatim when MEMPHIS_THINK_FILTER=0', () => {
    const input = '<think>reasoning</think>body';
    expect(stripThinkBlocks(input, { MEMPHIS_THINK_FILTER: '0' })).toBe(input);
    expect(stripThinkBlocks(input, { MEMPHIS_THINK_FILTER: 'false' })).toBe(input);
  });

  it('default behavior is to strip (no env var set)', () => {
    expect(stripThinkBlocks('<think>x</think>body', {})).toBe('body');
  });

  it('removes leading whitespace left over after stripping leading <think>', () => {
    // Without a leading-whitespace trim, "<think>x</think>\n\nReal" would
    // leave "\n\nReal" with two blank lines on top, looking broken in
    // Telegram. trimStart() handles it.
    expect(stripThinkBlocks('<think>x</think>\n\nReal', {})).toBe('Real');
  });
});
