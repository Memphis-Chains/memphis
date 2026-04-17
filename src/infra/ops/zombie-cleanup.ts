import { execSync } from 'node:child_process';

import type { CliContext } from '../cli/context.js';
import { print } from '../cli/utils/render.js';

export interface ZombieCleanupResult {
  killed: number;
  remaining: number;
  errors: string[];
}

/**
 * Decide whether a ps-aux cmdline belongs to a Memphis process.
 * Must require `memphis` in the cmdline — a prior version was
 * `tsx || node && memphis` (precedence: `tsx || (node && memphis)`), which
 * terminated every tsx process on the host (#133).
 */
export function isMemphisProcess(cmd: string): boolean {
  return (cmd.includes('tsx') || cmd.includes('node')) && cmd.includes('memphis');
}

function getMemphisProcesses(): Array<{ pid: number; cmd: string }> {
  try {
    const output = execSync('ps aux', { encoding: 'utf8' });
    const lines = output.split('\n').filter(Boolean);
    const processes: Array<{ pid: number; cmd: string }> = [];

    for (const line of lines) {
      // Skip header
      if (line.startsWith('USER') || line.startsWith('  ')) continue;

      const parts = line.trim().split(/\s+/);
      if (parts.length < 11) continue;

      const pid = parseInt(parts[1], 10);
      if (isNaN(pid)) continue;

      const cmd = parts.slice(10).join(' ');
      if (isMemphisProcess(cmd)) {
        processes.push({ pid, cmd });
      }
    }

    return processes;
  } catch {
    return [];
  }
}

function killProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
  try {
    execSync(`kill -${signal} ${pid}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function waitForProcesses(pids: number[], timeoutMs: number): Promise<number[]> {
  const start = Date.now();
  const remaining: number[] = [];

  for (const pid of pids) {
    let stillRunning = true;
    while (stillRunning && Date.now() - start < timeoutMs) {
      try {
        execSync(`kill -0 ${pid}`, { stdio: 'ignore' });
        await new Promise((resolve) => setTimeout(resolve, 100));
      } catch {
        stillRunning = false;
      }
    }
    if (stillRunning) {
      remaining.push(pid);
    }
  }

  return remaining;
}

export async function killZombies(options: {
  dryRun?: boolean;
  port?: number;
} = {}): Promise<ZombieCleanupResult> {
  const result: ZombieCleanupResult = { killed: 0, remaining: 0, errors: [] };

  // Quick method: fuser -k 3000/tcp if port specified
  if (options.port) {
    try {
      const portOutput = execSync(`fuser ${options.port}/tcp 2>&1`, { encoding: 'utf8' });
      if (portOutput.trim()) {
        if (options.dryRun) {
          result.killed++;
        } else {
          try {
            execSync(`fuser -k ${options.port}/tcp`, { stdio: 'ignore' });
            result.killed++;
          } catch (e) {
            result.errors.push(`fuser failed: ${e}`);
          }
        }
      }
    } catch {
      // fuser returns non-zero if no processes found - that's OK
    }
  }

  // Full method: find tsx/node Memphis processes
  if (!options.dryRun) {
    const processes = getMemphisProcesses();

    for (const { pid, cmd } of processes) {
      // Skip if this is the current process
      if (pid === process.pid) continue;

      // Try SIGTERM first
      const termOk = killProcess(pid, 'SIGTERM');
      if (termOk) {
        result.killed++;
      } else {
        result.errors.push(`failed to send SIGTERM to PID ${pid}: ${cmd}`);
      }
    }

    // Wait 5 seconds for processes to exit
    const pids = processes.map((p) => p.pid).filter((p) => p !== process.pid);
    const remaining = await waitForProcesses(pids, 5000);

    // SIGKILL any that are still alive
    for (const pid of remaining) {
      const killOk = killProcess(pid, 'SIGKILL');
      if (killOk) {
        result.killed++;
      } else {
        result.errors.push(`failed to send SIGKILL to PID ${pid}`);
        result.remaining++;
      }
    }
  } else {
    // Dry run - just count
    const processes = getMemphisProcesses().filter((p) => p.pid !== process.pid);
    result.killed = processes.length;
  }

  return result;
}

export async function handleZombieCommand(context: CliContext): Promise<boolean> {
  const { args } = context;

  if (args.command !== 'kill-zombies') return false;

  const port = typeof args.port === 'number' ? args.port : 3000;
  const dryRun = args.dryRun === true;

  const result = await killZombies({ dryRun, port });

  print(
    {
      ok: result.errors.length === 0 && result.remaining === 0,
      mode: dryRun ? 'dry-run' : 'kill',
      killed: result.killed,
      remaining: result.remaining,
      errors: result.errors,
    },
    args.json,
  );

  return true;
}
