import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';
import { runMemphisSelfGovernanceStatus } from '../../../mcp/tools/self-governance-status.js';
import { print } from '../utils/render.js';

export const selfGovernanceCommandHandler: CommandHandler = {
  name: 'self-governance',
  commands: ['self-governance', 'self_governance'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'self-governance' || context.args.command === 'self_governance';
  },
  async handle(context: CliContext): Promise<boolean> {
    const subcommand = context.args.subcommand ?? 'status';
    if (subcommand !== 'status') {
      throw new Error(`Unknown self-governance subcommand: ${String(subcommand)}`);
    }
    print(await runMemphisSelfGovernanceStatus(process.env), context.args.json);
    return true;
  },
};
