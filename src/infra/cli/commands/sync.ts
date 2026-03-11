import { SyncManager } from '../../../sync/sync-manager.js';
import { print } from '../utils/render.js';
import type { CliContext } from '../context.js';

export async function handleSyncCommand(context: CliContext): Promise<boolean> {
  const { args } = context;
  const { command, subcommand, json, chain, agent, target } = args;
  if (command !== 'sync') return false;

  const manager = new SyncManager(process.env.MEMPHIS_DID ?? 'did:memphis:local');

  if (subcommand === 'status') {
    print({ ok: true, mode: 'sync-status', ...manager.status(chain ?? 'journal') }, json);
    return true;
  }

  if (subcommand === 'push') {
    print({ ok: true, mode: 'sync-push', ...(await manager.push(chain ?? 'journal')) }, json);
    return true;
  }

  if (subcommand === 'pull') {
    const agentDid = agent ?? target;
    if (!agentDid) throw new Error('sync pull requires --agent <did>');
    print({ ok: true, mode: 'sync-pull', ...(await manager.pull(agentDid, chain ?? 'journal')) }, json);
    return true;
  }

  throw new Error(`Unknown sync subcommand: ${String(subcommand)}`);
}
