import { describe, expect, it, vi } from 'vitest';
import { ModelA_ConsciousCapture } from '../../src/cognitive/model-a.js';

describe('Model A — Conscious Capture', () => {
  it('captures explicit decision into decisions chain', async () => {
    const append = vi.fn().mockResolvedValue({
      index: 7,
      hash: 'abc123',
      chain: 'decisions',
      timestamp: '2026-03-11T00:00:00.000Z',
    });

    const model = new ModelA_ConsciousCapture(
      { captureLevel: 'normal', requireConfirmation: false },
      { append },
    );

    const result = await model.capture({
      kind: 'decision',
      title: 'Use PostgreSQL',
      content: 'Decided to use PostgreSQL for reliability.',
      tags: ['Database'],
    });

    expect(result.captured).toBe(true);
    expect(result.chainRef?.chain).toBe('decisions');
    expect(append).toHaveBeenCalledTimes(1);

    const [chainName, payload] = append.mock.calls[0];
    expect(chainName).toBe('decisions');
    expect(payload).toMatchObject({
      type: 'decision',
      mode: 'conscious',
      kind: 'decision',
    });
    expect(payload.tags).toContain('database');
    expect(payload.tags).toContain('model-a');
  });

  it('autoCapture asks for confirmation when required', async () => {
    const append = vi.fn();
    const model = new ModelA_ConsciousCapture(
      { autoCapture: true, requireConfirmation: true },
      { append },
    );

    const result = await model.autoCapture({
      content: 'Decision: we will migrate to TypeScript this sprint.',
    });

    expect(result.captured).toBe(false);
    expect(result.needsConfirmation).toBe(true);
    expect(result.preview?.kind).toBe('decision');
    expect(append).not.toHaveBeenCalled();
  });

  it('autoCapture writes after explicit confirmation', async () => {
    const append = vi.fn().mockResolvedValue({
      index: 11,
      hash: 'def456',
      chain: 'decisions',
      timestamp: '2026-03-11T00:01:00.000Z',
    });

    const model = new ModelA_ConsciousCapture(
      { autoCapture: true, requireConfirmation: true },
      { append },
    );

    const result = await model.autoCapture({
      content: 'Decision: we will use OpenTelemetry for tracing.',
      confirmed: true,
    });

    expect(result.captured).toBe(true);
    expect(result.chainRef?.index).toBe(11);
    expect(append).toHaveBeenCalledTimes(1);
  });

  it('returns no_capture_signal when text has no signal', async () => {
    const append = vi.fn();
    const model = new ModelA_ConsciousCapture({ autoCapture: true }, { append });

    const result = await model.autoCapture({ content: 'ok' });

    expect(result.captured).toBe(false);
    expect(result.reason).toBe('no_capture_signal');
    expect(append).not.toHaveBeenCalled();
  });
});
