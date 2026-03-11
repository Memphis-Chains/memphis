import { createCliContext } from './context.js';
import type { CliArgs } from './types.js';
import { dispatchCommand } from './handlers/command-handler.js';
import { systemCommandHandler } from './handlers/system.handler.js';
import { embedCommandHandler } from './handlers/embed.handler.js';
import { vaultCommandHandler } from './handlers/vault.handler.js';
import { storageCommandHandler } from './handlers/storage.handler.js';
import { decisionCommandHandler } from './handlers/decision.handler.js';
import { mcpCommandHandler } from './handlers/mcp.handler.js';
import { cognitiveCommandHandler } from './handlers/cognitive.handler.js';
import { syncCommandHandler } from './handlers/sync.handler.js';
import { interactionCommandHandler } from './handlers/interaction.handler.js';
import { debugCommandHandler } from './handlers/debug.handler.js';

export async function executeCommand(argv: string[], args: CliArgs): Promise<void> {
  const context = createCliContext(argv, args);

  const handled = await dispatchCommand(context, [
    systemCommandHandler,
    embedCommandHandler,
    vaultCommandHandler,
    storageCommandHandler,
    decisionCommandHandler,
    mcpCommandHandler,
    cognitiveCommandHandler,
    syncCommandHandler,
    interactionCommandHandler,
    debugCommandHandler,
  ]);

  if (!handled) {
    throw new Error(`Unknown command: ${args.command}`);
  }
}
