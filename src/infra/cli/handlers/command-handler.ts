import type { CliContext } from '../context.js';

export interface CommandHandler {
  readonly name: string;
  readonly commands: readonly (string | undefined)[];
  canHandle(context: CliContext): boolean;
  handle(context: CliContext): Promise<boolean>;
}

export async function dispatchCommand(
  context: CliContext,
  handlers: readonly CommandHandler[],
): Promise<boolean> {
  const candidates = handlers.filter((handler) =>
    handler.commands.includes(context.args.command),
  );

  for (const handler of candidates) {
    if (!handler.canHandle(context)) {
      continue;
    }
    if (await handler.handle(context)) {
      return true;
    }
  }

  return false;
}
