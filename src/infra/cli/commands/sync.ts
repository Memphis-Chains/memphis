import { SyncManager } from '../../../sync/sync-manager.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

export async function handleSyncCommand(context: CliContext): Promise<boolean> {
  if (context.args.command !== 'sync') return false;
  const manager = new SyncManager(process.env.MEMPHIS_DID ?? 'did:memphis:local');
  const { subcommand } = context.args;
  const handlers: Record<string, () => Promise<boolean>> = {
    status: async () => {
      print(
        { ok: true, mode: 'sync-status', ...manager.status(context.args.chain ?? 'journal') },
        context.args.json,
      );
      return true;
    },
    push: async () => {
      print(
        { ok: true, mode: 'sync-push', ...(await manager.push(context.args.chain ?? 'journal')) },
        context.args.json,
      );
      return true;
    },
    pull: async () => {
      const agentDid = context.args.agent ?? context.args.target;
      if (!agentDid) throw new Error('sync pull requires --agent <did>');
      print(
        {
          ok: true,
          mode: 'sync-pull',
          ...(await manager.pull(agentDid, context.args.chain ?? 'journal')),
        },
        context.args.json,
      );
      return true;
    },
  };
  const handler = subcommand ? handlers[subcommand] : undefined;
  if (!handler) throw new Error(`Unknown sync subcommand: ${String(subcommand)}`);
  return handler();
}
