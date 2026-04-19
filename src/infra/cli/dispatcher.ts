import { createCliContext } from './context.js';
import { dispatchCommand } from './handlers/command-handler.js';
import { getCliCommandRegistrations } from './registry.js';
import type { CliArgs } from './types.js';

export async function executeCommand(argv: string[], args: CliArgs): Promise<void> {
  const hasHelpFlag = argv.includes('--help');
  const normalizedArgs =
    hasHelpFlag && args.command !== 'help' && args.command !== '--help'
      ? { ...args, command: 'help', subcommand: undefined, target: undefined }
      : args;

  const context = createCliContext(argv, normalizedArgs);
  const registrations = getCliCommandRegistrations(normalizedArgs.command);
  const handlers = await Promise.all(
    registrations.map((registration) => registration.loadHandler()),
  );

  const handled = await dispatchCommand(context, handlers);

  if (!handled) {
    throw new Error(`Unknown command: ${normalizedArgs.command}`);
  }
}
