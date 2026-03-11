import type { CliContext } from '../context.js';
import { dispatchCommand } from '../handlers/command-handler.js';
import { embedCommandHandler } from '../handlers/embed.handler.js';
import { storageCommandHandler } from '../handlers/storage.handler.js';
import { vaultCommandHandler } from '../handlers/vault.handler.js';

export async function handleStorageCommand(context: CliContext): Promise<boolean> {
  return dispatchCommand(context, [
    embedCommandHandler,
    vaultCommandHandler,
    storageCommandHandler,
  ]);
}
