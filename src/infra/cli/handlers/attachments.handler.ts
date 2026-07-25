import type { CommandHandler } from './command-handler.js';
import { pruneTelegramAttachments } from '../../runtime/scheduler-builtins.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

export const attachmentsCommandHandler: CommandHandler = {
  name: 'attachments',
  commands: ['attachments'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'attachments';
  },
  async handle(context: CliContext): Promise<boolean> {
    if ((context.args.subcommand ?? 'prune') !== 'prune') {
      throw new Error('attachments supports only: memphis attachments prune --dry-run|--apply');
    }
    const apply = context.args.apply === true && context.args.dryRun !== true;
    if (apply) {
      const { requireOperatorAuth } = await import('../../auth/operator-gate.js');
      if (!(await requireOperatorAuth(undefined, process.env, context.args.operatorPassphrase))) {
        throw new Error('Operator authentication failed.');
      }
    }
    const result = pruneTelegramAttachments({ rawEnv: process.env, apply });
    print({ ok: true, applied: apply, ...result }, context.args.json);
    return true;
  },
};
