import { describe, expect, test } from 'vitest';
import { renderStatusWidget } from '../../src/tui/components/status-widget.js';

describe('StatusWidget', () => {
  test('renders provider status correctly', () => {
    const frame = renderStatusWidget({
      provider: 'openai-compatible',
      model: 'gpt-4',
      latency: 850,
      tokensUsed: 1250,
    });

    expect(frame).toContain('openai-compatible');
    expect(frame).toContain('gpt-4');
    expect(frame).toContain('850ms');
    expect(frame).toContain('1250');
  });

  test('handles provider errors gracefully', () => {
    const frame = renderStatusWidget({
      provider: 'ollama',
      error: 'Connection refused',
    });

    expect(frame).toContain('error');
    expect(frame).toContain('Connection refused');
  });

  test('shows memory chain health', () => {
    const frame = renderStatusWidget({
      chainHealth: {
        totalBlocks: 42,
        lastBlockHash: 'abc123',
        integrity: 'VALID',
      },
    });

    expect(frame).toContain('42 blocks');
    expect(frame).toContain('VALID');
  });
});
