import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';
import { getTensorStatus } from '../../tensors/status.js';
import { print } from '../utils/render.js';

export const tensorCommandHandler: CommandHandler = {
  name: 'tensor',
  commands: ['tensor', 'tensors'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'tensor' || context.args.command === 'tensors';
  },
  async handle(context: CliContext): Promise<boolean> {
    const subcommand = context.args.subcommand ?? 'status';
    if (subcommand !== 'status') {
      throw new Error(`Unknown tensor subcommand: ${String(subcommand)}`);
    }
    print({ ok: true, data: getTensorStatus(process.env) }, context.args.json);
    return true;
  },
};
