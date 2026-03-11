import { createCliContext } from './context.js';
import { handleSystemCommand } from './commands/system.js';
import { handleStorageCommand } from './commands/storage.js';
import { handleDecisionCommand } from './commands/decision.js';
import { handleMcpCommand } from './commands/mcp.js';
import { handleCognitiveCommand } from './commands/cognitive.js';
import { handleInteractionCommand } from './commands/interaction.js';
import { handleSyncCommand } from './commands/sync.js';
import type { CliArgs } from './types.js';

export async function executeCommand(argv: string[], args: CliArgs): Promise<void> {
  const context = createCliContext(argv, args);
  const handlers = [
    handleSystemCommand,
    handleStorageCommand,
    handleDecisionCommand,
    handleMcpCommand,
    handleCognitiveCommand,
    handleSyncCommand,
    handleInteractionCommand,
  ];

  for (const handler of handlers) {
    if (await handler(context)) return;
  }

  throw new Error(`Unknown command: ${args.command}`);
}
