import { runMemphisSearch } from '../../../mcp/tools/search.js';
import { rebuildExactSearchIndex } from '../../memory/exact-search.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';
import { print } from '../utils/render.js';

export const searchCommandHandler: CommandHandler = {
  name: 'search',
  commands: ['search'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'search';
  },
  async handle(context: CliContext): Promise<boolean> {
    const { chain, json, query, subcommand, topK } = context.args;

    if (subcommand === 'rebuild') {
      const data = rebuildExactSearchIndex({ chain });
      print({ ok: true, data }, json);
      return true;
    }

    if (!query) {
      throw new Error('search requires --query or use "search rebuild"');
    }

    const data = runMemphisSearch({ query, limit: topK ?? 10, chain });
    print({ ok: true, data }, json);
    return true;
  },
};
