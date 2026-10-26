import { describe, expect, it } from 'vitest';

import { createSchedulerRuntimeTools } from '../../src/gateway/tool-executor/domains/scheduler-tools.js';

describe('the scheduler tool', () => {
  const cron = createSchedulerRuntimeTools().find((tool) => tool.name === 'memphis_cron');

  // The registry declares timezone, period and job. The executor used to
  // drop all three, so a builtin task could not be created through the
  // gateway at all — and a reflection task always landed on the default
  // period and the host timezone.
  it('keeps the parameters the registry declares', () => {
    expect(cron).toBeDefined();
    const input = cron!.validateInput?.({
      action: 'add',
      cron: '0 2 * * *',
      name: 'nightly',
      taskType: 'builtin',
      job: 'scheduled-backup',
      timezone: 'Europe/Warsaw',
      period: 'weekly',
    });

    expect(input).toMatchObject({
      action: 'add',
      taskType: 'builtin',
      job: 'scheduled-backup',
      timezone: 'Europe/Warsaw',
      period: 'weekly',
    });
  });

  it('advertises the same parameters in its schema', () => {
    const schema = cron!.inputSchema as {
      properties: Record<string, { enum?: string[] }>;
    };
    expect(Object.keys(schema.properties)).toContain('job');
    expect(Object.keys(schema.properties)).toContain('timezone');
    expect(Object.keys(schema.properties)).toContain('period');
    expect(schema.properties.job?.enum).toContain('scheduled-backup');
    expect(schema.properties.taskType?.enum).toContain('builtin');
  });
});
