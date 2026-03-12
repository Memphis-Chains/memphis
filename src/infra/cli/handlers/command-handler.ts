import type { CliContext } from '../context.js';

export interface CommandHandler {
  readonly name: string;
  readonly commands: readonly (string | undefined)[];
  canHandle(context: CliContext): boolean;
  handle(context: CliContext): Promise<boolean>;
}

type CommandKey = string | undefined;
type CommandIndex = Map<CommandKey, CommandHandler[]>;

const handlerIndexCache = new WeakMap<readonly CommandHandler[], CommandIndex>();

function buildHandlerIndex(handlers: readonly CommandHandler[]): CommandIndex {
  const index: CommandIndex = new Map();
  for (const handler of handlers) {
    for (const command of handler.commands) {
      const bucket = index.get(command);
      if (bucket) bucket.push(handler);
      else index.set(command, [handler]);
    }
  }
  return index;
}

function getHandlerIndex(handlers: readonly CommandHandler[]): CommandIndex {
  const cached = handlerIndexCache.get(handlers);
  if (cached) return cached;
  const built = buildHandlerIndex(handlers);
  handlerIndexCache.set(handlers, built);
  return built;
}

export async function dispatchCommand(
  context: CliContext,
  handlers: readonly CommandHandler[],
): Promise<boolean> {
  const candidates = getHandlerIndex(handlers).get(context.args.command) ?? [];

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
