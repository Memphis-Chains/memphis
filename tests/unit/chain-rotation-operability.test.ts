/**
 * The operator can see the scheduled rotation, and can ask for one now.
 *
 * ## The failures this exists for
 *
 * **The loop was silent when it had nothing to do.** It logged only when
 * a chain actually rotated, so a tick that found nothing was invisible.
 *
 * Measured 2026-11-23 on this host: the service log held six
 * `chain.rotation.loop.started` events and not one
 * `chain.rotation.scheduled` — which reads as "the loop never ticks".
 * The loop HAD ticked, hourly, and every tick had found nothing to
 * rotate, because the threshold could not fire. The silence was the
 * symptom, not the cause, and it cost an hour of looking for a dead
 * timer that was running fine.
 *
 * **The command the documentation promised did not exist.** The rotation
 * loop's own header says "Operator-driven `chain rotate` has shipped
 * since Sprint 4". The subcommand was never registered:
 *
 *     $ memphis chain rotate --chain insights
 *     [INTERNAL_ERROR] Unknown chain subcommand: rotate. Available:
 *     import_json, export, verify, rebuild, diagnose, rebuild-hashes,
 *     restore, migrate.
 *
 * **And a command run from a shell used the wrong numbers.** The
 * operator's threshold lives in the service's systemd drop-in. A shell
 * has no such variables, so the command would compare against the code
 * default (50 MB) while the service compares against the operator's
 * threshold (10 MB) — and "nothing to do" would look like a decision
 * rather than a different number.
 *
 * ## What each test pins
 *
 *   - "the loop says it ticked, even when nothing rotated" — the
 *     heartbeat.
 *   - "the knob precedence is flag, shell, service, default" — the
 *     resolution order, and the SOURCE it reports.
 *   - "the service's drop-in is read" — the parser.
 *   - "chain rotate is a command the operator can run" — the
 *     registration, through the real CLI.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';


const logged = vi.hoisted(() => {
  const entries: { level: string; payload: Record<string, unknown>; msg?: string }[] = [];
  return { entries };
});

vi.mock('../../src/infra/logging/pino.js', () => {
  const record =
    (level: string) =>
    (payload: unknown, msg?: string): void => {
      logged.entries.push({
        level,
        payload: (payload ?? {}) as Record<string, unknown>,
        msg,
      });
    };
  const makeLogger = (): Record<string, unknown> => {
    const logger: Record<string, unknown> = {
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      debug: record('debug'),
      trace: record('trace'),
      fatal: record('fatal'),
    };
    // `createContextualLogger` asks the root logger for a child.
    logger.child = () => makeLogger();
    return logger;
  };
  return {
    createPinoLogger: () => makeLogger(),
    setAllPinoLoggerLevels: () => ({ updated: 0, skipped: 0 }),
    __resetPinoRegistryForTests: () => undefined,
    flushAllPinoStreamsSync: () => ({ flushed: 0, errors: 0 }),
  };
});

import {
  parseServiceEnvironment,
  readServiceEnvironment,
} from '../../src/infra/config/service-env.js';
import {
  startChainRotationLoop,
} from '../../src/infra/runtime/chain-rotation-loop.js';
import { resolveRotationKnobs } from '../../src/infra/storage/chain-rotation.js';
import type { ChainRotationResult } from '../../src/infra/storage/chain-rotation.js';
import { runCli } from '../helpers/cli.js';

const NOOP_RESULT: ChainRotationResult = {
  chain: 'memphis',
  rotated: false,
  archivedBlocks: 0,
  remainingBlocks: 5,
  dirSizeBytes: 1024,
};

const ROTATED_RESULT: ChainRotationResult = {
  chain: 'memphis',
  rotated: true,
  archivedBlocks: 90,
  archivePath: '/tmp/archive.jsonl.gz',
  remainingBlocks: 10,
  dirSizeBytes: 2048,
};

describe('the rotation is visible and runnable on demand', () => {
  beforeEach(() => {
    logged.entries.length = 0;
  });

  it('the loop says it ticked, even when nothing rotated', async () => {
    const handle = startChainRotationLoop({
      rawEnv: { MEMPHIS_CHAIN_ROTATE_INTERVAL_MS: '3600000' } as NodeJS.ProcessEnv,
      rotateFn: async () => [NOOP_RESULT],
    });

    await handle.tickNow();
    handle.stop();

    const events = logged.entries.map((entry) => entry.payload.event);

    // The heartbeat: a tick that found nothing to do is still a tick.
    expect(events).toContain('chain.rotation.scheduled.start');

    // The completion event stays what it was — it says what HAPPENED, so
    // it is absent when nothing happened. The heartbeat is what says the
    // loop is alive.
    expect(events).not.toContain('chain.rotation.scheduled');
  });

  it('the loop says what it rotated', async () => {
    const handle = startChainRotationLoop({
      rawEnv: { MEMPHIS_CHAIN_ROTATE_INTERVAL_MS: '3600000' } as NodeJS.ProcessEnv,
      rotateFn: async () => [ROTATED_RESULT],
    });

    await handle.tickNow();
    handle.stop();

    const completed = logged.entries.find(
      (entry) => entry.payload.event === 'chain.rotation.scheduled',
    );
    expect(completed).toBeDefined();
    expect(completed?.payload.rotatedChains).toEqual(['memphis']);
    expect(completed?.payload.archivedBlocks).toBe(90);
  });

  it('the knob precedence is flag, shell, service, default', () => {
    // The flag wins over everything.
    const withFlag = resolveRotationKnobs({
      rawEnv: {
        MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES: '2000000',
        MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS: '20',
      } as NodeJS.ProcessEnv,
      serviceEnv: {
        MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES: '3000000',
        MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS: '30',
      },
      thresholdBytes: 4000000,
      minKeepBlocks: 40,
    });
    expect(withFlag.knobs.thresholdBytes).toBe(4000000);
    expect(withFlag.knobs.thresholdSource).toBe('flag');
    expect(withFlag.knobs.minKeepBlocks).toBe(40);
    expect(withFlag.knobs.keepSource).toBe('flag');
    // The environment the rotation runs with carries the flag, so the
    // rotation code reads exactly the numbers that were reported.
    expect(withFlag.env.MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES).toBe('4000000');

    // The shell wins over the service.
    const withShell = resolveRotationKnobs({
      rawEnv: {
        MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES: '2000000',
      } as NodeJS.ProcessEnv,
      serviceEnv: {
        MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES: '3000000',
      },
    });
    expect(withShell.knobs.thresholdBytes).toBe(2000000);
    expect(withShell.knobs.thresholdSource).toBe('shell');

    // The service answers when the shell says nothing.
    const withService = resolveRotationKnobs({
      rawEnv: {} as NodeJS.ProcessEnv,
      serviceEnv: {
        MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES: '3000000',
        MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS: '30',
      },
    });
    expect(withService.knobs.thresholdBytes).toBe(3000000);
    expect(withService.knobs.thresholdSource).toBe('service');
    expect(withService.knobs.minKeepBlocks).toBe(30);
    expect(withService.knobs.keepSource).toBe('service');

    // With nothing anywhere, the code default answers — and says so.
    const withDefault = resolveRotationKnobs({ rawEnv: {} as NodeJS.ProcessEnv });
    expect(withDefault.knobs.thresholdSource).toBe('default');
    expect(withDefault.knobs.keepSource).toBe('default');
    expect(withDefault.knobs.thresholdBytes).toBeGreaterThan(0);
  });

  it("the service's drop-in is read", () => {
    const dir = mkdtempSync(join(tmpdir(), 'memphis-service-env-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '40-production.conf'),
      [
        '[Service]',
        'Environment=MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES=10485760',
        'Environment=MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS=500',
        '# a comment',
        'Environment="MEMPHIS_QUOTED=has spaces"',
        'NotEnvironment=IGNORED',
      ].join('\n'),
      'utf8',
    );

    const env = readServiceEnvironment(dir);
    expect(env.MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES).toBe('10485760');
    expect(env.MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS).toBe('500');
    expect(env.MEMPHIS_QUOTED).toBe('has spaces');
    expect(env.NotEnvironment).toBeUndefined();

    // A directory that does not exist is not an error — it is a host
    // without a service.
    expect(readServiceEnvironment(join(dir, 'does-not-exist'))).toEqual({});

    // The parser on its own.
    expect(parseServiceEnvironment('Environment=A=1').A).toBe('1');
    expect(parseServiceEnvironment('Environment=A=1\nEnvironment=B=2').B).toBe('2');
    expect(parseServiceEnvironment('nothing here')).toEqual({});
  });

  it('chain rotate is a command the operator can run', async () => {
    // A home of its own: the data dir AND the drop-in dir live under it,
    // so the test cannot read the operator's real configuration.
    const home = mkdtempSync(join(tmpdir(), 'memphis-rotate-cli-'));

    const out = await runCli(['chain', 'rotate', '--chain', 'cases', '--json'], {
      cwd: home,
      env: { HOME: home } as NodeJS.ProcessEnv,
    });
    const parsed = JSON.parse(out) as {
      knobs?: {
        thresholdBytes?: number;
        thresholdSource?: string;
        minKeepBlocks?: number;
        keepSource?: string;
      };
      chain?: { chain?: string; rotated?: boolean };
    };

    // The command answers with the knobs it used AND where they came
    // from — a number without a source is a number that can mislead.
    expect(parsed.knobs?.thresholdBytes).toBeGreaterThan(0);
    expect(parsed.knobs?.thresholdSource).toBeDefined();
    expect(parsed.knobs?.minKeepBlocks).toBeGreaterThan(0);
    expect(parsed.knobs?.keepSource).toBeDefined();

    // And it rotated the chain it was asked about.
    expect(parsed.chain?.chain).toBe('cases');
    expect(typeof parsed.chain?.rotated).toBe('boolean');
  });

  it('chain rotate reports the flags the operator typed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'memphis-rotate-cli-flags-'));

    const out = await runCli(
      [
        'chain',
        'rotate',
        '--chain',
        'cases',
        '--threshold-bytes',
        '2000000',
        '--keep-blocks',
        '7',
        '--json',
      ],
      { cwd: home, env: { HOME: home } as NodeJS.ProcessEnv },
    );
    const parsed = JSON.parse(out) as {
      knobs?: { thresholdBytes?: number; thresholdSource?: string; minKeepBlocks?: number; keepSource?: string };
    };

    expect(parsed.knobs?.thresholdBytes).toBe(2000000);
    expect(parsed.knobs?.thresholdSource).toBe('flag');
    expect(parsed.knobs?.minKeepBlocks).toBe(7);
    expect(parsed.knobs?.keepSource).toBe('flag');
  });
});
