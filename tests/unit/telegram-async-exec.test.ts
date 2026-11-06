import { afterEach, describe, expect, it } from 'vitest';

import { resetAllExecBudgetsForTests } from '../../src/gateway/exec-failure-budget.js';
import { createExecRuntimeTools } from '../../src/gateway/tool-executor/domains/exec-tools.js';
import { runMemphisExec, runMemphisExecAsync } from '../../src/mcp/tools/exec.js';

const env = { ...process.env, VITEST: 'true', MEMPHIS_AUTONOMY_MODE: 'full' };

describe('Telegram asynchronous exec', () => {
  afterEach(() => resetAllExecBudgetsForTests());

  it('does not block the event loop and preserves command results', async () => {
    const pending = runMemphisExecAsync({ command: 'sleep 0.3; printf fixture' }, env, {
      surface: 'telegram',
      actorId: 'actor-a',
    });
    const tick = await Promise.race([
      new Promise<string>((resolve) => setTimeout(() => resolve('responsive'), 30)),
      pending.then(() => 'finished'),
    ]);
    expect(tick).toBe('responsive');
    await expect(pending).resolves.toMatchObject({ exitCode: 0, stdout: 'fixture', stderr: '' });
  });

  it('matches the synchronous path for success and ordinary non-zero exit', async () => {
    for (const command of ['printf fixture', 'printf failed >&2; exit 7']) {
      const sync = runMemphisExec({ command }, env, { surface: 'cli', actorId: 'sync' });
      const asyncResult = await runMemphisExecAsync({ command }, env, {
        surface: 'telegram',
        actorId: 'async',
      });
      expect(asyncResult).toEqual(sync);
    }
  });

  it('enforces the same per-actor failure budget under concurrent submissions', async () => {
    const identity = { surface: 'telegram', actorId: 'actor-budget' };
    const attempts = await Promise.allSettled(
      Array.from({ length: 4 }, () => runMemphisExecAsync({ command: 'exit 1' }, env, identity)),
    );
    expect(attempts.slice(0, 3).map((x) => x.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'fulfilled',
    ]);
    expect(attempts[3]?.status).toBe('rejected');
    if (attempts[3]?.status === 'rejected') expect(String(attempts[3].reason)).toContain('budget');
    await expect(
      runMemphisExecAsync({ command: 'printf ok' }, env, {
        surface: 'telegram',
        actorId: 'different',
      }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: 'ok' });
  });

  it('uses the nonblocking exec path through the Telegram runtime tool', async () => {
    const exec = createExecRuntimeTools({
      surface: 'telegram',
      sessionId: 'actor-runtime',
      rawEnv: env,
    }).find((tool) => tool.name === 'memphis_exec');
    expect(exec).toBeDefined();
    const pending = Promise.resolve(exec!.execute({ command: 'sleep 0.3; printf done' }, {}));
    const tick = await Promise.race([
      new Promise<string>((resolve) => setTimeout(() => resolve('responsive'), 30)),
      pending.then(() => 'finished'),
    ]);
    expect(tick).toBe('responsive');
    await expect(pending).resolves.toMatchObject({ exitCode: 0, stdout: 'done' });
  });
});
