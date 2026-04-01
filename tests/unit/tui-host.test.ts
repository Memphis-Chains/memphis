import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TSX_BIN = join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = join(PROJECT_ROOT, 'src', 'infra', 'cli', 'index.ts');

function spawnTuiHost(tempDir: string): ChildProcess {
  return spawn(TSX_BIN, [CLI_ENTRY, 'tui', 'host', '--stdio-json'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      MEMPHIS_SKIP_FIRST_RUN_CHECKS: '1',
      MEMPHIS_DATA_DIR: tempDir,
      DATABASE_URL: `file:${join(tempDir, 'memphis.db')}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

type HostEvent = Record<string, unknown>;

function createEventReader(child: ChildProcess): () => Promise<HostEvent> {
  const rl = readline.createInterface({
    input: child.stdout!,
    crlfDelay: Infinity,
  });
  const queued: HostEvent[] = [];
  const waiters: Array<{
    resolve: (event: HostEvent) => void;
    reject: (error: unknown) => void;
  }> = [];

  rl.on('line', (line: string) => {
    try {
      const event = JSON.parse(line) as HostEvent;
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve(event);
      } else {
        queued.push(event);
      }
    } catch (error) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter.reject(error);
      }
    }
  });

  return () =>
    new Promise<HostEvent>((resolve, reject) => {
      const next = queued.shift();
      if (next) {
        resolve(next);
        return;
      }
      waiters.push({ resolve, reject });
    });
}

async function collectUntilTerminal(
  nextEvent: () => Promise<HostEvent>,
  requestId: string,
): Promise<{ lines: HostEvent[]; terminal: HostEvent }> {
  const lines: HostEvent[] = [];

  while (true) {
    const event = await nextEvent();
    if (event.id !== requestId) {
      continue;
    }
    if (event.type === 'line') {
      lines.push(event);
      continue;
    }
    return { lines, terminal: event };
  }
}

describe('tui host', { timeout: 30_000 }, () => {
  const children: Array<ReturnType<typeof spawn>> = [];
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) {
      child.kill();
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits ready and executes config.tools.list over stdio JSON', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'memphis-tui-host-'));
    tempDirs.push(tempDir);
    const child = spawnTuiHost(tempDir);
    children.push(child);
    const nextEvent = createEventReader(child);

    const ready = await nextEvent();
    expect(ready.type).toBe('ready');
    expect(ready.protocolVersion).toBe(1);
    expect(Array.isArray(ready.capabilities)).toBe(true);
    expect(ready.capabilities).toContain('health.status');
    expect(ready.capabilities).toContain('init.status');
    expect(ready.capabilities).toContain('knowledge.status');
    expect(ready.capabilities).toContain('knowledge.query');
    expect(ready.capabilities).toContain('config.surfaces.list');
    expect(ready.capabilities).toContain('config.surfaces.check');
    expect(ready.capabilities).toContain('config.surfaces.set');
    expect(ready.capabilities).toContain('config.surfaces.reset');

    child.stdin!.write(
      `${JSON.stringify({
        type: 'execute',
        id: 'req-1',
        command: 'config.tools.list',
        args: {},
      })}\n`,
    );

    const started = await nextEvent();
    expect(started).toMatchObject({
      type: 'started',
      id: 'req-1',
      label: 'config.tools.list',
    });

    const { lines, terminal } = await collectUntilTerminal(nextEvent, 'req-1');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatchObject({
      type: 'line',
      id: 'req-1',
      level: 'info',
    });
    expect(terminal.type).toBe('result');
    expect(terminal.id).toBe('req-1');
    expect(terminal.data).toMatchObject({ tools: [] });
  }, 15000);

  it('executes config.surfaces.list over stdio JSON', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'memphis-tui-host-'));
    tempDirs.push(tempDir);
    const child = spawnTuiHost(tempDir);
    children.push(child);
    const nextEvent = createEventReader(child);

    const ready = await nextEvent();
    expect(ready.type).toBe('ready');

    child.stdin!.write(
      `${JSON.stringify({
        type: 'execute',
        id: 'surfaces-1',
        command: 'config.surfaces.list',
        args: {},
      })}\n`,
    );

    const started = await nextEvent();
    expect(started).toMatchObject({
      type: 'started',
      id: 'surfaces-1',
      label: 'config.surfaces.list',
    });

    const { lines, terminal } = await collectUntilTerminal(nextEvent, 'surfaces-1');
    expect(lines.length).toBeGreaterThan(0);
    expect(terminal).toMatchObject({
      type: 'result',
      id: 'surfaces-1',
      data: expect.objectContaining({
        surfaces: expect.arrayContaining([
          expect.objectContaining({ surface: 'telegram' }),
          expect.objectContaining({ surface: 'cli.chat' }),
        ]),
      }),
    });
  }, 15000);

  it('executes knowledge.query over stdio JSON with bounded results', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'memphis-tui-host-'));
    tempDirs.push(tempDir);
    const child = spawnTuiHost(tempDir);
    children.push(child);
    const nextEvent = createEventReader(child);

    const ready = await nextEvent();
    expect(ready.type).toBe('ready');

    child.stdin!.write(
      `${JSON.stringify({
        type: 'execute',
        id: 'knowledge-1',
        command: 'knowledge.query',
        args: {
          topic: 'Fastify',
          source: 'knowledge-synth',
          limit: 2,
        },
      })}\n`,
    );

    const started = await nextEvent();
    expect(started).toMatchObject({
      type: 'started',
      id: 'knowledge-1',
      label: 'knowledge.query',
    });

    const { lines, terminal } = await collectUntilTerminal(nextEvent, 'knowledge-1');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatchObject({
      type: 'line',
      id: 'knowledge-1',
      level: 'info',
    });
    expect(terminal).toMatchObject({
      type: 'result',
      id: 'knowledge-1',
      data: expect.objectContaining({
        mode: 'knowledge.query',
        source: 'knowledge-synth',
      }),
    });
    const payload = terminal.data as {
      hits: Array<{ sourceId: string }>;
    };
    expect(payload.hits.length).toBeGreaterThan(0);
    expect(payload.hits[0]?.sourceId).toBe('knowledge-synth');
  }, 15000);

  it('executes health.status over stdio JSON with runtime degradation fields', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'memphis-tui-host-'));
    tempDirs.push(tempDir);
    const child = spawnTuiHost(tempDir);
    children.push(child);
    const nextEvent = createEventReader(child);

    const ready = await nextEvent();
    expect(ready.type).toBe('ready');

    child.stdin!.write(
      `${JSON.stringify({
        type: 'execute',
        id: 'health-1',
        command: 'health.status',
        args: {},
      })}\n`,
    );

    const started = await nextEvent();
    expect(started).toMatchObject({
      type: 'started',
      id: 'health-1',
      label: 'health.status',
    });

    const { lines, terminal } = await collectUntilTerminal(nextEvent, 'health-1');
    expect(lines.length).toBeGreaterThan(0);
    expect(terminal).toMatchObject({
      type: 'result',
      id: 'health-1',
      data: expect.objectContaining({
        status: expect.any(String),
        repairable: expect.any(Boolean),
        recommendedAction: expect.any(String),
        runtime: expect.objectContaining({
          firstRun: expect.objectContaining({
            state: expect.any(String),
            plan: expect.objectContaining({
              nextCommand: expect.any(String),
            }),
          }),
          memory: expect.objectContaining({
            recallMode: expect.any(String),
          }),
          embeddings: expect.objectContaining({
            status: expect.any(String),
          }),
          cognition: expect.objectContaining({
            persistenceStatus: expect.any(String),
          }),
          repair: expect.objectContaining({
            status: expect.any(String),
            recommendedAction: expect.any(String),
          }),
        }),
        surfacePolicies: expect.arrayContaining([
          expect.objectContaining({
            surface: 'telegram',
            maxToolTier: expect.any(Number),
          }),
          expect.objectContaining({
            surface: 'cli.chat',
            allowOperatorOverride: true,
          }),
        ]),
      }),
    });
  }, 15000);

  it('executes init.status over stdio JSON with first-run plan details', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'memphis-tui-host-'));
    tempDirs.push(tempDir);
    const child = spawnTuiHost(tempDir);
    children.push(child);
    const nextEvent = createEventReader(child);

    const ready = await nextEvent();
    expect(ready.type).toBe('ready');

    child.stdin!.write(
      `${JSON.stringify({
        type: 'execute',
        id: 'init-1',
        command: 'init.status',
        args: {},
      })}\n`,
    );

    const started = await nextEvent();
    expect(started).toMatchObject({
      type: 'started',
      id: 'init-1',
      label: 'init.status',
    });

    const { lines, terminal } = await collectUntilTerminal(nextEvent, 'init-1');
    expect(lines.length).toBeGreaterThan(0);
    expect(terminal).toMatchObject({
      type: 'result',
      id: 'init-1',
      data: expect.objectContaining({
        state: expect.any(String),
        plan: expect.objectContaining({
          nextCommand: expect.any(String),
        }),
      }),
    });
  }, 15000);

  it('returns a protocol error for malformed JSON without crashing the host', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'memphis-tui-host-'));
    tempDirs.push(tempDir);
    const child = spawnTuiHost(tempDir);
    children.push(child);
    const nextEvent = createEventReader(child);

    const ready = await nextEvent();
    expect(ready.type).toBe('ready');

    child.stdin!.write('not json\n');

    const protocolError = await nextEvent();
    expect(protocolError).toMatchObject({
      type: 'error',
      id: '__protocol__',
      message: 'invalid JSON request',
    });

    child.stdin!.write(
      `${JSON.stringify({
        type: 'execute',
        id: 'req-2',
        command: 'config.tools.list',
        args: {},
      })}\n`,
    );

    const started = await nextEvent();
    expect(started).toMatchObject({
      type: 'started',
      id: 'req-2',
      label: 'config.tools.list',
    });

    const { lines, terminal } = await collectUntilTerminal(nextEvent, 'req-2');
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatchObject({
      type: 'line',
      id: 'req-2',
      level: 'info',
    });
    expect(terminal).toMatchObject({
      type: 'result',
      id: 'req-2',
    });
  }, 15000);

  it('resolves apps.show from a file-backed manifest path', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'memphis-tui-host-'));
    tempDirs.push(tempDir);
    const manifestPath = join(tempDir, 'demo.json');
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          id: 'demo-app',
          name: 'Demo App',
          description: 'demo app',
          actions: {
            status: {
              summary: 'print status token',
              steps: ['printf status-ready'],
            },
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const child = spawnTuiHost(tempDir);
    children.push(child);
    const nextEvent = createEventReader(child);

    const ready = await nextEvent();
    expect(ready.type).toBe('ready');

    child.stdin!.write(
      `${JSON.stringify({
        type: 'execute',
        id: 'req-app-show-file',
        command: 'apps.show',
        args: { file: manifestPath },
      })}\n`,
    );

    const started = await nextEvent();
    expect(started).toMatchObject({
      type: 'started',
      id: 'req-app-show-file',
      label: 'apps.show',
    });

    const { lines, terminal } = await collectUntilTerminal(nextEvent, 'req-app-show-file');
    expect(lines.length).toBeGreaterThan(0);
    expect(terminal).toMatchObject({
      type: 'result',
      id: 'req-app-show-file',
      data: {
        manifest: {
          id: 'demo-app',
          name: 'Demo App',
        },
      },
    });
  }, 15000);

  it('returns a bounded busy error when a second request arrives mid-flight', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'memphis-tui-host-'));
    tempDirs.push(tempDir);
    const child = spawnTuiHost(tempDir);
    children.push(child);
    const nextEvent = createEventReader(child);

    const ready = await nextEvent();
    expect(ready.type).toBe('ready');

    child.stdin!.write(
      `${JSON.stringify({
        type: 'execute',
        id: 'req-busy-1',
        command: 'config.tools.list',
        args: { __testDelayMs: 200 },
      })}\n`,
    );

    const started = await nextEvent();
    expect(started).toMatchObject({
      type: 'started',
      id: 'req-busy-1',
      label: 'config.tools.list',
    });

    child.stdin!.write(
      `${JSON.stringify({
        type: 'execute',
        id: 'req-busy-2',
        command: 'config.tools.list',
        args: {},
      })}\n`,
    );

    const busyError = await nextEvent();
    expect(busyError).toMatchObject({
      type: 'error',
      id: 'req-busy-2',
      message: 'host is busy; only one in-flight request is supported',
    });

    const { terminal } = await collectUntilTerminal(nextEvent, 'req-busy-1');
    expect(terminal).toMatchObject({
      type: 'result',
      id: 'req-busy-1',
    });
  }, 15000);

  it('cancels a delayed request and continues serving later requests', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'memphis-tui-host-'));
    tempDirs.push(tempDir);
    const child = spawnTuiHost(tempDir);
    children.push(child);
    const nextEvent = createEventReader(child);

    const ready = await nextEvent();
    expect(ready.type).toBe('ready');

    child.stdin!.write(
      `${JSON.stringify({
        type: 'execute',
        id: 'req-cancel-1',
        command: 'config.tools.list',
        args: { __testDelayMs: 500 },
      })}\n`,
    );

    const started = await nextEvent();
    expect(started).toMatchObject({
      type: 'started',
      id: 'req-cancel-1',
      label: 'config.tools.list',
    });

    child.stdin!.write(
      `${JSON.stringify({
        type: 'cancel',
        id: 'req-cancel-1',
      })}\n`,
    );

    const cancelled = await nextEvent();
    expect(cancelled).toMatchObject({
      type: 'cancelled',
      id: 'req-cancel-1',
    });

    child.stdin!.write(
      `${JSON.stringify({
        type: 'execute',
        id: 'req-cancel-2',
        command: 'config.tools.list',
        args: {},
      })}\n`,
    );

    const restarted = await nextEvent();
    expect(restarted).toMatchObject({
      type: 'started',
      id: 'req-cancel-2',
      label: 'config.tools.list',
    });

    const { terminal } = await collectUntilTerminal(nextEvent, 'req-cancel-2');
    expect(terminal).toMatchObject({
      type: 'result',
      id: 'req-cancel-2',
    });
  }, 15000);

  it('returns an error when cancelling an unknown request id', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'memphis-tui-host-'));
    tempDirs.push(tempDir);
    const child = spawnTuiHost(tempDir);
    children.push(child);
    const nextEvent = createEventReader(child);

    const ready = await nextEvent();
    expect(ready.type).toBe('ready');

    child.stdin!.write(
      `${JSON.stringify({
        type: 'cancel',
        id: 'missing-request',
      })}\n`,
    );

    const error = await nextEvent();
    expect(error).toMatchObject({
      type: 'error',
      id: 'missing-request',
      message: 'unknown request id',
    });
  });
});
