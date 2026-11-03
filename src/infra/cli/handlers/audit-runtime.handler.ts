import { handleAuditRuntimeCommand } from '../commands/audit-runtime.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';

const AUDIT_RUNTIME_COMMANDS = ['audit-runtime'] as const;

export const auditRuntimeCommandHandler: CommandHandler = {
  name: 'audit-runtime',
  commands: AUDIT_RUNTIME_COMMANDS,
  canHandle(context: CliContext): boolean {
    return AUDIT_RUNTIME_COMMANDS.includes(
      context.args.command as (typeof AUDIT_RUNTIME_COMMANDS)[number],
    );
  },
  handle(context: CliContext): Promise<boolean> {
    return handleAuditRuntimeCommand(context);
  },
};
