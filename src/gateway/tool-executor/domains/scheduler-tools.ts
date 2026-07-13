import { runMemphisCron } from '../../../mcp/tools/cron.js';
import { buildTool, type RuntimeToolDefinition } from '../../tool-runtime.js';
import { optionalString, requiredString } from '../input-normalization.js';

export function createSchedulerRuntimeTools(): RuntimeToolDefinition[] {
  return [
    buildTool({
      name: 'memphis_cron',
      description:
        'Manage recurring Memphis-internal scheduled tasks — list, add, remove, enable, disable cron jobs. Not a one-off reminder/alarm system.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'Action: list | add | remove | enable | disable' },
          cron: {
            type: 'string',
            description: 'Recurring cron expression (for add, e.g. "0 * * * *" = hourly)',
          },
          name: { type: 'string', description: 'Task name (for add)' },
          taskType: {
            type: 'string',
            description: 'Task type: shell | reflection | git-pull-build | http',
          },
          script: { type: 'string', description: 'Shell script (for shell type)' },
          url: { type: 'string', description: 'URL (for http type)' },
          method: { type: 'string', description: 'HTTP method (for http type, default GET)' },
          taskId: { type: 'string', description: 'Task ID (for remove/enable/disable)' },
        },
        required: ['action'],
      },
      isReadOnly: false,
      isDestructive: true,
      validateInput(args) {
        return {
          action: requiredString(args, 'action') as
            | 'list'
            | 'add'
            | 'remove'
            | 'enable'
            | 'disable',
          cron: optionalString(args, 'cron'),
          name: optionalString(args, 'name'),
          taskType: optionalString(args, 'taskType') as
            | 'shell'
            | 'reflection'
            | 'git-pull-build'
            | 'http'
            | undefined,
          script: optionalString(args, 'script'),
          url: optionalString(args, 'url'),
          method: optionalString(args, 'method'),
          taskId: optionalString(args, 'taskId'),
        };
      },
      execute(input) {
        return runMemphisCron(input);
      },
    }),
  ];
}
