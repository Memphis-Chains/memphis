import type { CliContext } from '../context.js';
import { systemCommandHandler } from '../handlers/system.handler.js';

export async function handleSystemCommand(context: CliContext): Promise<boolean> {
  return systemCommandHandler.handle(context);
}
