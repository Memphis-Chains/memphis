import { handleSkillsCommand } from '../commands/skills.js';
import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';

const SKILLS_COMMANDS = ['skills', 'skill'] as const;

export const skillsCommandHandler: CommandHandler = {
  name: 'skills',
  commands: SKILLS_COMMANDS,
  canHandle(context: CliContext): boolean {
    return SKILLS_COMMANDS.includes(context.args.command as (typeof SKILLS_COMMANDS)[number]);
  },
  async handle(context: CliContext): Promise<boolean> {
    return handleSkillsCommand(context);
  },
};
