import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';
import { storeDurableMemory } from '../../memory/durable-memory.js';
import { rebuildDerivedEmbeddings } from '../../memory/embed-reindex.js';
import { embedSearch, embedSearchTuned, embedReset } from '../../storage/rust-embed-adapter.js';
import { print } from '../utils/render.js';

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
      // CLI is an operator-surface write: operator explicitly typed
      // the command, so default consent is 'exportable'. No turnId —
      // this is an out-of-turn direct memory seed, not a conversation turn.
      print(
        {
          ok: true,
          data: await storeDurableMemory({
            memoryId: id,
            content: value,
            source: 'cli-embed',
            tags: ['operator-memory'],
            consent: 'exportable',
          }),
        },
        json,
      );
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

    if (subcommand === 'reindex') {
      const chain = (context.args as Record<string, unknown>).chain as string | undefined;
      const result = rebuildDerivedEmbeddings({ chain }, process.env);
      print({ ok: true, data: result }, json);
      return true;
    }

    throw new Error(`Unknown embed subcommand: ${String(subcommand)}`);
  },
};
