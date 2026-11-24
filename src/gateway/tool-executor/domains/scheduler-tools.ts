import { runMemphisCron } from '../../../mcp/tools/cron.js';
import { buildRegistryInputJsonSchema } from '../../tool-json-schema.js';
import { buildTool, type RuntimeToolDefinition } from '../../tool-runtime.js';
import { optionalString, requiredString } from '../input-normalization.js';

export function createSchedulerRuntimeTools(): RuntimeToolDefinition[] {
  return [
    buildTool({
      name: 'memphis_cron',
      description:
        'Manage recurring Memphis-internal scheduled tasks — list, add, remove, enable, disable cron jobs. Not a one-off reminder/alarm system.',
      inputSchema: buildRegistryInputJsonSchema('memphis_cron', {
        propertyDescriptions: {
          action: 'Action: list | add | remove | enable | disable',
          cron: 'Recurring cron expression (for add, e.g. "0 * * * *" = hourly)',
          name: 'Task name (for add)',
          taskType: 'Task type: shell | reflection | git-pull-build | builtin | http',
          timezone: 'Timezone for the schedule (e.g. Europe/Warsaw); defaults to the host timezone',
          period: 'Run period for a reflection task',
          job: 'Built-in job to schedule (required for taskType builtin)',
          script: 'Shell script (for shell type)',
          url: 'URL (for http type)',
          method: 'HTTP method (for http type, default GET)',
          taskId: 'Task ID (for remove/enable/disable)',
        },
      }),
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
            | 'builtin'
            | 'http'
            | undefined,
          timezone: optionalString(args, 'timezone'),
          period: optionalString(args, 'period') as 'daily' | 'weekly' | undefined,
          job: optionalString(args, 'job') as
            | 'runtime-watch'
            | 'scheduled-backup'
            | 'doctor-diagnose'
            | 'operator-briefing'
            | 'attachment-retention'
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
