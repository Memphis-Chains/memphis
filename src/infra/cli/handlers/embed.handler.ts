import {
  embedReset,
  embedSearch,
  embedSearchTuned,
  embedStore,
} from '../../storage/rust-embed-adapter.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';
import type { CommandHandler } from './command-handler.js';

export const embedCommandHandler: CommandHandler = {
  name: 'embed',
  commands: ['embed'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'embed';
  },
  async handle(context: CliContext): Promise<boolean> {
    const { id, json, query, subcommand, topK, tuned, value } = context.args;

    if (subcommand === 'reset') {
      print({ ok: true, data: embedReset(process.env) }, json);
      return true;
    }

    if (subcommand === 'store') {
      if (!id || value === undefined) {
        throw new Error('embed store requires --id and --value');
      }
      print({ ok: true, data: embedStore(id, value, process.env) }, json);
      return true;
    }

    if (subcommand === 'search') {
      if (!query) {
        throw new Error('embed search requires --query');
      }
      const data = tuned
        ? embedSearchTuned(query, topK ?? 5, process.env)
        : embedSearch(query, topK ?? 5, process.env);
      print({ ok: true, data }, json);
      return true;
    }

    throw new Error(`Unknown embed subcommand: ${String(subcommand)}`);
  },
};
