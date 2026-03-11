import type { CliContext } from '../context.js';

export interface CommandHandler {
  readonly name: string;
  canHandle(context: CliContext): boolean;
  handle(context: CliContext): Promise<boolean>;
}

export async function dispatchCommand(
  context: CliContext,
  handlers: readonly CommandHandler[],
): Promise<boolean> {
  for (const handler of handlers) {
    if (!handler.canHandle(context)) continue;
    if (await handler.handle(context)) return true;
  }

  return false;
}
