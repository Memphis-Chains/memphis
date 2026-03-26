import { describe, expect, it, vi } from 'vitest';

import type { CliContext } from '../../src/infra/cli/context.js';
import { searchCommandHandler } from '../../src/infra/cli/handlers/search.handler.js';

const print = vi.fn();
const rebuildExactSearchIndex = vi.fn();
const runMemphisSearch = vi.fn();

vi.mock('../../src/infra/cli/utils/render.js', () => ({
  print: (...args: unknown[]) => print(...args),
}));

vi.mock('../../src/infra/memory/exact-search.js', () => ({
  rebuildExactSearchIndex: (...args: unknown[]) => rebuildExactSearchIndex(...args),
}));

vi.mock('../../src/mcp/tools/search.js', () => ({
  runMemphisSearch: (...args: unknown[]) => runMemphisSearch(...args),
}));

function makeContext(overrides: Partial<CliContext['args']> = {}): CliContext {
  return {
    argv: ['node', 'memphis', 'search'],
    args: {
      command: 'search',
      subcommand: undefined,
      target: undefined,
      json: true,
      tui: false,
      write: false,
      save: false,
      confirmWrite: false,
      register: false,
      interactive: false,
      nonInteractive: false,
      force: false,
      noVault: false,
      apply: false,
      dryRun: false,
      yes: false,
      schema: false,
      verbose: false,
      vision: false,
      functions: false,
      reset: false,
      runtime: false,
      list: false,
      clean: false,
      safeMode: false,
      strictMode: false,
      ...overrides,
    },
    getConfig: vi.fn() as never,
    getContainer: vi.fn() as never,
  };
}

describe('search CLI handler', () => {
  it('runs exact search query flow', async () => {
    runMemphisSearch.mockReturnValueOnce({ results: [{ sourceKey: 'journal:1' }] });

    const handled = await searchCommandHandler.handle(
      makeContext({ query: 'vault pepper', topK: 7, chain: 'journal' }),
    );

    expect(handled).toBe(true);
    expect(runMemphisSearch).toHaveBeenCalledWith({
      query: 'vault pepper',
      limit: 7,
      chain: 'journal',
    });
    expect(print).toHaveBeenCalledWith({ ok: true, data: { results: [{ sourceKey: 'journal:1' }] } }, true);
  });

  it('runs exact search rebuild flow', async () => {
    rebuildExactSearchIndex.mockReturnValueOnce({ indexed: 2, skipped: 0, total: 2, chains: ['journal'] });

    const handled = await searchCommandHandler.handle(
      makeContext({ subcommand: 'rebuild', chain: 'journal' }),
    );

    expect(handled).toBe(true);
    expect(rebuildExactSearchIndex).toHaveBeenCalledWith({ chain: 'journal' });
    expect(print).toHaveBeenCalledWith(
      { ok: true, data: { indexed: 2, skipped: 0, total: 2, chains: ['journal'] } },
      true,
    );
  });
});
