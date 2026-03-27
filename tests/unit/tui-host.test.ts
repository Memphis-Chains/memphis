import { ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

  return () =>
    new Promise<HostEvent>((resolvePromise, reject) => {
      const onLine = (line: string) => {
        rl.off('line', onLine);
        try {
          resolvePromise(JSON.parse(line) as HostEvent);
        } catch (error) {
          reject(error);
        }
      };
      rl.on('line', onLine);
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

describe('tui host', () => {
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
