import { createCliContext } from './context.js';
import { appsCommandHandler } from './handlers/apps.handler.js';
import { cognitiveCommandHandler } from './handlers/cognitive.handler.js';
import { dispatchCommand } from './handlers/command-handler.js';
import { configCommandHandler } from './handlers/config.handler.js';
import { debugCommandHandler } from './handlers/debug.handler.js';
import { decisionCommandHandler } from './handlers/decision.handler.js';
import { embedCommandHandler } from './handlers/embed.handler.js';
import { evolveCommandHandler } from './handlers/evolve.handler.js';
import { explainCommandHandler } from './handlers/explain.handler.js';
import { interactionCommandHandler } from './handlers/interaction.handler.js';
import { mcpCommandHandler } from './handlers/mcp.handler.js';
import {
  isGatedOperation,
  isOperatorConfigured,
  requireOperatorAuth,
} from '../auth/operator-gate.js';
import { operatorCommandHandler } from './handlers/operator.handler.js';
import { secretCommandHandler } from './handlers/secret.handler.js';
import { storageCommandHandler } from './handlers/storage.handler.js';
import { syncCommandHandler } from './handlers/sync.handler.js';
import { systemCommandHandler } from './handlers/system.handler.js';
import { telegramCommandHandler } from './handlers/telegram.handler.js';
import { trustCommandHandler } from './handlers/trust.handler.js';
import { vaultCommandHandler } from './handlers/vault.handler.js';
import type { CliArgs } from './types.js';

const CLI_COMMAND_HANDLERS = [
  appsCommandHandler,
  configCommandHandler,
  systemCommandHandler,
  embedCommandHandler,
  vaultCommandHandler,
  storageCommandHandler,
  decisionCommandHandler,
  mcpCommandHandler,
  cognitiveCommandHandler,
  syncCommandHandler,
  interactionCommandHandler,
  trustCommandHandler,
  evolveCommandHandler,
  explainCommandHandler,
  debugCommandHandler,
  operatorCommandHandler,
  secretCommandHandler,
  telegramCommandHandler,
] as const;

export async function executeCommand(argv: string[], args: CliArgs): Promise<void> {
  const hasHelpFlag = argv.includes('--help');
  const normalizedArgs =
    hasHelpFlag && args.command !== 'help' && args.command !== '--help'
      ? { ...args, command: 'help', subcommand: undefined, target: undefined }
      : args;

  // Operator gate: check if this command requires authorization
  if (isGatedOperation(normalizedArgs.command, normalizedArgs.subcommand, normalizedArgs)) {
    if (isOperatorConfigured()) {
      const authorized = await requireOperatorAuth(
        undefined,
        process.env,
        normalizedArgs.operatorPassphrase,
      );
      if (!authorized) {
        throw new Error('Operator authentication required. Aborting.');
      }
    }
  }

  const context = createCliContext(argv, normalizedArgs);

  const handled = await dispatchCommand(context, CLI_COMMAND_HANDLERS);

  if (!handled) {
    throw new Error(`Unknown command: ${normalizedArgs.command}`);
  }
}
