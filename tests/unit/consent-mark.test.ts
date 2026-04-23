import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/infra/storage/rust-chain-adapter.js', () => ({
  getRecentBlocks: vi.fn(async () => [
    { index: 0, hash: 'h0' },
    { index: 1, hash: 'h1' },
    { index: 2, hash: 'h2' },
  ]),
}));

const appendBlockMock = vi.fn(async () => ({ index: 42, hash: 'annotation-hash' }));
vi.mock('../../src/infra/storage/chain-adapter.js', () => ({
  appendBlock: appendBlockMock,
}));

const { consentCommandHandler } = await import(
  '../../src/infra/cli/handlers/consent.handler.js'
);

function mkCtx(args: Record<string, unknown>): {
  args: Record<string, unknown> & { command: 'consent' };
  getContainer: () => unknown;
  getConfig: () => unknown;
} {
  return {
    args: { command: 'consent', ...args },
    getContainer: () => ({}),
    getConfig: () => ({}),
  };
}

describe('consent mark CLI', () => {
  it('rejects unknown consent level', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      consentCommandHandler.handle(
        mkCtx({ subcommand: 'mark', chain: 'journal', fromIndex: 0, level: 'bogus', json: true }) as any,
      ),
    ).rejects.toThrow(/--level must be one of/);
  });

  it('rejects missing --chain', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      consentCommandHandler.handle(
        mkCtx({ subcommand: 'mark', fromIndex: 0, level: 'exportable', json: true }) as any,
      ),
    ).rejects.toThrow(/requires --chain/);
  });

  it('rejects --from-index past chain tip', async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      consentCommandHandler.handle(
        mkCtx({ subcommand: 'mark', chain: 'journal', fromIndex: 99, level: 'exportable', json: true }) as any,
      ),
    ).rejects.toThrow(/past the tip/);
  });

  it('dry-run does not append; normal run appends annotation to journal', async () => {
    appendBlockMock.mockClear();
    // Dry run
    await consentCommandHandler.handle(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mkCtx({
        subcommand: 'mark',
        chain: 'journal',
        fromIndex: 1,
        level: 'local-only',
        dryRun: true,
        json: true,
      }) as any,
    );
    expect(appendBlockMock).not.toHaveBeenCalled();
    // Real run
    await consentCommandHandler.handle(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mkCtx({
        subcommand: 'mark',
        chain: 'journal',
        fromIndex: 1,
        level: 'local-only',
        dryRun: false,
        json: true,
      }) as any,
    );
    expect(appendBlockMock).toHaveBeenCalledTimes(1);
    const [chainArg, payload] = appendBlockMock.mock.calls[0];
    expect(chainArg).toBe('journal');
    expect(payload).toMatchObject({
      type: 'consent.annotation',
      target_chain: 'journal',
      from_index: 1,
      to_index: 2,
      level: 'local-only',
      source: 'cli.consent-mark',
    });
  });
});
