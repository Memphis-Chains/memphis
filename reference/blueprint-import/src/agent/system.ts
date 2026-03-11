/**
 * Memphis Agent — system-level capabilities
 *
 * The agent can:
 * - Execute shell commands (exec)
 * - Read/write/manage files (fs)
 * - Manage running applications (apps)
 * - Interact with the host system (system)
 *
 * All actions are logged to chain (ops or log) for auditability.
 * Dangerous operations require explicit user approval.
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ═══════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════

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

// ═══════════════════════════════════════════
// AGENT
// ═══════════════════════════════════════════

/** Managed child processes */
const managedApps: Map<string, ChildProcess> = new Map();

/** Blocked commands (security) */
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\/(?!\w)/, // rm -rf /
  /mkfs/,
  /dd\s+if=.*of=\/dev/,
  /:(){ :\|:& };:/, // fork bomb
  />\s*\/dev\/sd/,
];

/**
 * Execute a shell command and return result
 */
export function exec(
  command: string,
  opts?: {
    cwd?: string;
    timeout?: number;
    env?: Record<string, string>;
  },
): ExecResult {
  // Security check
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return {
        command,
        exitCode: -1,
        stdout: '',
        stderr: `BLOCKED: Command matches dangerous pattern`,
        durationMs: 0,
      };
    }
  }

  const start = Date.now();
  try {
    const stdout = execSync(command, {
      cwd: opts?.cwd || process.cwd(),
      timeout: opts?.timeout || 30_000,
      env: { ...process.env, ...opts?.env },
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });

    return {
      command,
      exitCode: 0,
      stdout: stdout?.toString() || '',
      stderr: '',
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      command,
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString() || '',
      stderr: err.stderr?.toString() || err.message,
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Execute command async (for long-running processes)
 */
export function execAsync(
  command: string,
  opts?: {
    cwd?: string;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  },
): Promise<ExecResult> {
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

// ═══════════════════════════════════════════
// FILESYSTEM
// ═══════════════════════════════════════════

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

// ═══════════════════════════════════════════
// APP MANAGEMENT
// ═══════════════════════════════════════════

/**
 * Launch a managed application
 */
export function launchApp(
  name: string,
  command: string,
  opts?: {
    cwd?: string;
    env?: Record<string, string>;
  },
): RunningApp {
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

/**
 * Stop a managed app
 */
export function stopApp(name: string): boolean {
  const child = managedApps.get(name);
  if (!child) return false;
  child.kill('SIGTERM');
  managedApps.delete(name);
  return true;
}

/**
 * List managed apps
 */
export function listApps(): RunningApp[] {
  const apps: RunningApp[] = [];
  for (const [name, child] of managedApps) {
    if (child.killed || child.exitCode !== null) {
      managedApps.delete(name);
      continue;
    }
    apps.push({
      pid: child.pid || 0,
      name,
      command: '',
      startedAt: '',
    });
  }
  return apps;
}

// ═══════════════════════════════════════════
// SYSTEM INFO
// ═══════════════════════════════════════════

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

// ═══════════════════════════════════════════
// OLLAMA MANAGEMENT
// ═══════════════════════════════════════════

/**
 * Check if Ollama is running
 */
export async function isOllamaRunning(url = 'http://127.0.0.1:11434'): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * List Ollama models
 */
export async function ollamaModels(url = 'http://127.0.0.1:11434'): Promise<string[]> {
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    return data.models?.map((m) => m.name) || [];
  } catch {
    return [];
  }
}

/**
 * Pull an Ollama model
 */
export function pullOllamaModel(model: string): Promise<ExecResult> {
  return execAsync(`ollama pull ${model}`, {
    onStdout: (data) => process.stdout.write(data),
  });
}

/**
 * Start Ollama if not running
 */
export function ensureOllama(): Promise<ExecResult | null> {
  return isOllamaRunning().then((running) => {
    if (running) return null;
    return execAsync('ollama serve &', {});
  });
}
