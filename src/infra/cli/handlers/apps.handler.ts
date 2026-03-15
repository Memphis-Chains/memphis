import { handleAppsCommand } from '../commands/apps.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';

const APPS_COMMANDS = ['apps'] as const;

export const appsCommandHandler: CommandHandler = {
  name: 'apps',
  commands: APPS_COMMANDS,
  canHandle(context: CliContext): boolean {
    return APPS_COMMANDS.includes(context.args.command as (typeof APPS_COMMANDS)[number]);
  },
  async handle(context: CliContext): Promise<boolean> {
    return handleAppsCommand(context);
  },
};
