/**
 * Orchestrator — pin routing + dry-run + unsupported-extension
 * handling. Adapter calls are mocked at the module level so we
 * exercise the routing layer without spinning up Ollama / whisper.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  transcribeAudioFile: vi.fn(async () => ({ kind: 'audio' as const, text: 'hello' })),
  describeImage: vi.fn(async () => ({
    kind: 'image' as const,
    description: 'a thing',
    tags: ['t1'],
  })),
  writeMediaToChains: vi.fn(async () => ({
    journalBlockIndex: 5,
    caseBlockIndices: [],
  })),
}));

vi.mock('../../src/gateway/media/audio-adapter.js', () => ({
  transcribeAudioFile: mocks.transcribeAudioFile,
}));
vi.mock('../../src/gateway/media/vision-adapter.js', () => ({
  describeImage: mocks.describeImage,
}));
vi.mock('../../src/gateway/media/chain-output.js', () => ({
  writeMediaToChains: mocks.writeMediaToChains,
}));

import { ingestMedia } from '../../src/gateway/media/orchestrator.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('ingestMedia', () => {
  it('routes .ogg to audio adapter and writes to chain', async () => {
    const result = await ingestMedia('/tmp/test.ogg');
    expect(mocks.transcribeAudioFile).toHaveBeenCalledWith('/tmp/test.ogg', expect.any(Object));
    expect(result.kind).toBe('audio');
    expect(result.payload.kind).toBe('audio');
    expect(result.chainOutput.journalBlockIndex).toBe(5);
    expect(mocks.writeMediaToChains).toHaveBeenCalled();
  });

  it('routes .png to vision adapter', async () => {
    const result = await ingestMedia('/tmp/test.png');
    expect(mocks.describeImage).toHaveBeenCalledWith('/tmp/test.png', {}, expect.any(Object));
    expect(result.kind).toBe('image');
  });

  it('routes .jpg / .jpeg / .webp to vision adapter', async () => {
    await ingestMedia('/tmp/test.jpg');
    await ingestMedia('/tmp/test.jpeg');
    await ingestMedia('/tmp/test.webp');
    expect(mocks.describeImage).toHaveBeenCalledTimes(3);
  });

  it('routes .wav / .mp3 / .opus / .m4a / .flac to audio adapter', async () => {
    for (const ext of ['.wav', '.mp3', '.opus', '.m4a', '.flac']) {
      await ingestMedia(`/tmp/test${ext}`);
    }
    expect(mocks.transcribeAudioFile).toHaveBeenCalledTimes(5);
  });

  it('returns B4-stub error for video kind (not yet implemented)', async () => {
    const result = await ingestMedia('/tmp/test.mp4');
    expect(result.kind).toBe('video');
    expect(result.error).toContain('not yet implemented');
    expect(result.error).toContain('B4');
    // No adapter or chain write attempted
    expect(mocks.transcribeAudioFile).not.toHaveBeenCalled();
    expect(mocks.describeImage).not.toHaveBeenCalled();
    expect(mocks.writeMediaToChains).not.toHaveBeenCalled();
  });

  it('returns error for unrecognised extension', async () => {
    const result = await ingestMedia('/tmp/test.xyz');
    expect(result.error).toContain('Unsupported');
    expect(mocks.transcribeAudioFile).not.toHaveBeenCalled();
    expect(mocks.describeImage).not.toHaveBeenCalled();
  });

  it('honors --dryRun: runs adapter but skips chain write', async () => {
    const result = await ingestMedia('/tmp/test.png', { dryRun: true });
    expect(mocks.describeImage).toHaveBeenCalled();
    expect(mocks.writeMediaToChains).not.toHaveBeenCalled();
    expect(result.chainOutput.journalBlockIndex).toBeUndefined();
  });

  it('honors explicit kind override', async () => {
    // .xyz is unknown — but kind=audio override should still route
    await ingestMedia('/tmp/test.xyz', { kind: 'audio' });
    expect(mocks.transcribeAudioFile).toHaveBeenCalledWith('/tmp/test.xyz', expect.any(Object));
  });

  it('measures elapsedMs', async () => {
    const result = await ingestMedia('/tmp/test.png');
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.elapsedMs).toBeLessThan(1000); // mocks are instant
  });
});
