/**
 * Memphis Agent — system-level capabilities
 *
 * The agent can:
 * - Execute shell commands (exec)
 * - Read/write/manage files (fs)
 * - Manage running applications (apps)
 * - Interact with the host system (system)
 */

import { ChildProcess, execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface ExecResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface FileInfo {
  path: string;
  size: number;
  isDirectory: boolean;
  modified: string;
  permissions: string;
}

export interface SystemInfo {
  hostname: string;
  platform: string;
  arch: string;
  uptime: number;
  totalMemMb: number;
  freeMemMb: number;
  cpuCount: number;
  loadAvg: number[];
  nodeVersion: string;
  memphisVersion: string;
  user: string;
  home: string;
  cwd: string;
}

export interface RunningApp {
  pid: number;
  name: string;
  command: string;
  startedAt: string;
}

const managedApps: Map<string, ChildProcess> = new Map();

const BLOCKED_PATTERNS = [
  /rm\s+(-\w+\s+)*\//i,                      // rm with any flags targeting root
  /rm\s+(-\w+\s+)*--no-preserve-root/i,       // explicit root removal
  /mkfs/i,                                     // filesystem creation
  /dd\b/i,                                     // dd (any form — too dangerous)
  /:\s*\(\s*\)\s*\{/,                          // fork bomb variants
  />\s*\/dev\//,                               // write to device files
  /chmod\s+(-\w+\s+)*[0-7]*[67][0-7]*\s+\//i, // chmod world-writable on root paths
  /chown\s+(-\w+\s+)*root/i,                   // chown to root
  /curl\b.*\|\s*(bash|sh|zsh)/i,               // pipe from network to shell
  /wget\b.*\|\s*(bash|sh|zsh)/i,               // pipe from network to shell
  /python[23]?\s+-c/i,                         // inline python execution
  /perl\s+-e/i,                                // inline perl execution
  /ruby\s+-e/i,                                // inline ruby execution
  /node\s+-e/i,                                // inline node execution
  /eval\s/i,                                   // shell eval
  /\bsudo\b/i,                                 // privilege escalation
  /\bsu\b\s/i,                                 // switch user
  /\/etc\/shadow/i,                            // shadow file access
  /\/etc\/passwd/i,                            // passwd file access
  /\bkill\s+-9\b/i,                            // force kill
  /\bkillall\b/i,                              // mass kill
  /\bshutdown\b/i,                             // system shutdown
  /\breboot\b/i,                               // system reboot
  /\bsystemctl\s+(stop|disable|mask)/i,        // disabling services
  /\biptables\b/i,                             // firewall manipulation
  /\bnc\b.*-[le]/i,                            // netcat listeners
  /\bncat\b/i,                                 // ncat
  /\bsocat\b/i,                                // socat
];

/**
 * Shell metacharacters that indicate command chaining, redirection, or injection.
 * These bypass allowlist checks by running additional commands after the allowed one.
 */
// eslint-disable-next-line no-control-regex
const SHELL_INJECTION_RE = /[;&|`$(){}[\]!#~<>\\'\n\r\x00-\x1f\x7f]/;

function isBlockedCommand(command: string): boolean {
  // First check for shell injection metacharacters
  if (SHELL_INJECTION_RE.test(command)) return true;
  // Then check blocked patterns
  return BLOCKED_PATTERNS.some((pattern) => pattern.test(command));
}

function blockedExecResult(command: string): ExecResult {
  return {
    command,
    exitCode: -1,
    stdout: '',
    stderr: 'BLOCKED: Command matches dangerous pattern',
    durationMs: 0,
  };
}

function inSafeMode(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  return (rawEnv.MEMPHIS_SAFE_MODE ?? '').toLowerCase() === 'true';
}

function safeModeExecResult(command: string): ExecResult {
  return {
    command,
    exitCode: -1,
    stdout: '',
    stderr: 'FORBIDDEN_IN_SAFE_MODE: command execution is disabled',
    durationMs: 0,
  };
}

export function exec(
  command: string,
  opts?: {
    cwd?: string;
    timeout?: number;
    env?: Record<string, string>;
  },
): ExecResult {
  if (inSafeMode()) {
    return safeModeExecResult(command);
  }
  if (isBlockedCommand(command)) return blockedExecResult(command);

  const start = Date.now();
  try {
    const stdout = execSync(command, {
      cwd: opts?.cwd || process.cwd(),
      timeout: opts?.timeout || 30_000,
      env: { ...process.env, ...opts?.env },
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      command,
      exitCode: 0,
      stdout: stdout?.toString() || '',
      stderr: '',
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const e = err as {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    return {
      command,
      exitCode: e.status ?? 1,
      stdout: e.stdout?.toString() || '',
      stderr: e.stderr?.toString() || e.message || 'Unknown error',
      durationMs: Date.now() - start,
    };
  }
}

export function execAsync(
  command: string,
  opts?: {
    cwd?: string;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  },
): Promise<ExecResult> {
  if (inSafeMode()) {
    return Promise.resolve(safeModeExecResult(command));
  }
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '';
    let stderr = '';

    const child = spawn('sh', ['-c', command], {
      cwd: opts?.cwd || process.cwd(),
      env: process.env,
    });

    child.stdout?.on('data', (data) => {
      const str = data.toString();
      stdout += str;
      opts?.onStdout?.(str);
    });

    child.stderr?.on('data', (data) => {
      const str = data.toString();
      stderr += str;
      opts?.onStderr?.(str);
    });

    child.on('close', (code) => {
      resolve({
        command,
        exitCode: code ?? 1,
        stdout,
        stderr,
        durationMs: Date.now() - start,
      });
    });
  });
}

export function readFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

export function writeFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
}

export function listDir(dirPath: string): FileInfo[] {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true }).map((entry) => {
    const fullPath = path.join(dirPath, entry.name);
    const stat = fs.statSync(fullPath);
    return {
      path: fullPath,
      size: stat.size,
      isDirectory: entry.isDirectory(),
      modified: stat.mtime.toISOString(),
      permissions: (stat.mode & 0o777).toString(8),
    };
  });
}

export function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

export function copyFile(src: string, dst: string): void {
  const dir = path.dirname(dst);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(src, dst);
}

export function deleteFile(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

export function fileSize(filePath: string): number {
  return fs.statSync(filePath).size;
}

export function launchApp(
  name: string,
  command: string,
  opts?: {
    cwd?: string;
    env?: Record<string, string>;
  },
): RunningApp {
  if (inSafeMode()) {
    throw new Error('FORBIDDEN_IN_SAFE_MODE: app launch is disabled');
  }
  const child = spawn('sh', ['-c', command], {
    cwd: opts?.cwd || process.cwd(),
    env: { ...process.env, ...opts?.env },
    detached: true,
    stdio: 'ignore',
  });

  child.unref();
  managedApps.set(name, child);

  return {
    pid: child.pid || 0,
    name,
    command,
    startedAt: new Date().toISOString(),
  };
}

export function stopApp(name: string): boolean {
  const child = managedApps.get(name);
  if (!child) return false;
  child.kill('SIGTERM');
  managedApps.delete(name);
  return true;
}

export function listApps(): RunningApp[] {
  const apps: RunningApp[] = [];
  for (const [name, child] of managedApps) {
    if (child.killed || child.exitCode !== null) {
      managedApps.delete(name);
      continue;
    }
    apps.push({ pid: child.pid || 0, name, command: '', startedAt: '' });
  }
  return apps;
}

export function getSystemInfo(): SystemInfo {
  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptime: os.uptime(),
    totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
    freeMemMb: Math.round(os.freemem() / 1024 / 1024),
    cpuCount: os.cpus().length,
    loadAvg: os.loadavg(),
    nodeVersion: process.version,
    memphisVersion: '4.0.0',
    user: os.userInfo().username,
    home: os.homedir(),
    cwd: process.cwd(),
  };
}

export async function isOllamaRunning(url = 'http://127.0.0.1:11434'): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ollamaModels(url = 'http://127.0.0.1:11434'): Promise<string[]> {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return data.models?.map((m) => m.name) || [];
  } catch {
    return [];
  }
}

export function pullOllamaModel(model: string): Promise<ExecResult> {
  if (inSafeMode()) {
    return Promise.resolve(safeModeExecResult(`ollama pull ${model}`));
  }
  return execAsync(`ollama pull ${model}`, {
    onStdout: (data) => process.stdout.write(data),
  });
}

export function ensureOllama(): Promise<ExecResult | null> {
  if (inSafeMode()) {
    return Promise.resolve(safeModeExecResult('ollama serve'));
  }
  return isOllamaRunning().then((running) => {
    if (running) return null;
    return execAsync('ollama serve &', {});
  });
}
