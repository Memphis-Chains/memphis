import type { CliContext } from '../context.js';
import { handleMcpCommand } from '../commands/mcp.js';
import type { CommandHandler } from './command-handler.js';

export const mcpCommandHandler: CommandHandler = {
  name: 'mcp',
  commands: ['mcp'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'mcp';
  },
  handle(context: CliContext): Promise<boolean> {
    return handleMcpCommand(context);
  },
};
