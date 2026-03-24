import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';
import { getChainPath } from '../../../config/paths.js';
import { storeDurableMemory } from '../../memory/durable-memory.js';
import {
  embedReset,
  embedSearch,
  embedSearchTuned,
  embedStore,
} from '../../storage/rust-embed-adapter.js';
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
      print(
        {
          ok: true,
          data: await storeDurableMemory({
            memoryId: id,
            content: value,
            source: 'cli-embed',
            tags: ['operator-memory'],
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
      const chainName = chain ?? 'journal';

      // Reset the embed index first
      embedReset(process.env);

      // Read chain blocks from individual JSON files (000001.json, 000002.json, ...)
      const chainDir = getChainPath(chainName);
      let blockFiles: string[];
      try {
        blockFiles = readdirSync(chainDir)
          .filter((f) => /^\d+\.json$/.test(f))
          .sort();
      } catch {
        print({ ok: false, error: `Chain directory not found: ${chainDir}` }, json);
        return true;
      }
      if (blockFiles.length === 0) {
        print({ ok: false, error: `No chain blocks in ${chainDir}` }, json);
        return true;
      }
      const lines = blockFiles.map((f) => readFileSync(join(chainDir, f), 'utf-8').trim());

      let indexed = 0;
      let skipped = 0;

      for (const line of lines) {
        try {
          const block = JSON.parse(line) as Record<string, unknown>;
          const data = block.data as Record<string, unknown> | undefined;
          const content = data?.content as string | undefined;
          if (!content || typeof content !== 'string' || content.trim().length === 0) {
            skipped++;
            continue;
          }

          const memoryId =
            (data?.memory_id as string | undefined) ?? `journal-${String(block.index)}`;
          const tags = Array.isArray(data?.tags)
            ? (data.tags as string[]).filter((t: unknown) => typeof t === 'string')
            : [];

          embedStore(memoryId, content, process.env, tags);
          indexed++;
        } catch {
          skipped++;
        }
      }

      print(
        { ok: true, data: { chain: chainName, indexed, skipped, total: lines.length } },
        json,
      );
      return true;
    }

    throw new Error(`Unknown embed subcommand: ${String(subcommand)}`);
  },
};
