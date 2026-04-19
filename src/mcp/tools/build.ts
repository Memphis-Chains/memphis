/**
 * memphis_build — auto-detect project type and run build.
 *
 * Detects: package.json (npm), Cargo.toml (cargo), pyproject.toml (python).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type MemphisBuildInput = {
  /** Subdirectory to build (relative to ~/memphis/). Defaults to project root. */
  project?: string;
  /** Override the build command entirely */
  command?: string;
  /** Build profile: debug (default) or release */
  profile?: 'debug' | 'release';
};

export type MemphisBuildOutput = {
  success: boolean;
  projectType: string;
  command: string;
  output: string;
  durationMs: number;
  error?: string;
};

const MAX_OUTPUT_BYTES = 32_768;
const TIMEOUT_MS = 300_000; // 5 min
const PROJECT_ROOT = path.join(os.homedir(), 'memphis');

type ProjectType = 'node' | 'rust' | 'python' | 'unknown';

function detectProjectType(dir: string): ProjectType {
  if (existsSync(path.join(dir, 'package.json'))) return 'node';
  if (existsSync(path.join(dir, 'Cargo.toml'))) return 'rust';
  if (existsSync(path.join(dir, 'pyproject.toml')) || existsSync(path.join(dir, 'setup.py')))
    return 'python';
  return 'unknown';
}

function defaultBuildCommand(
  projectType: ProjectType,
  profile: string,
): { cmd: string; args: string[] } | null {
  switch (projectType) {
    case 'node':
      return { cmd: 'npm', args: ['run', 'build'] };
    case 'rust':
      return profile === 'release'
        ? { cmd: 'cargo', args: ['build', '--release'] }
        : { cmd: 'cargo', args: ['build'] };
    case 'python':
      return { cmd: 'python3', args: ['-m', 'build'] };
    default:
      return null;
  }
}

export function runMemphisBuild(input: MemphisBuildInput): MemphisBuildOutput {
  const startMs = Date.now();
  const profile = input.profile ?? 'debug';
  const buildDir = input.project ? path.resolve(PROJECT_ROOT, input.project) : PROJECT_ROOT;

  // Sandbox check
  const normalized = path.normalize(buildDir);
  const memphisDir = path.join(os.homedir(), 'memphis');
  if (!normalized.startsWith(memphisDir + path.sep) && normalized !== memphisDir) {
    return {
      success: false,
      projectType: 'unknown',
      command: '',
      output: '',
      durationMs: Date.now() - startMs,
      error: `Build directory '${buildDir}' is outside ~/memphis/`,
    };
  }

  if (!existsSync(buildDir)) {
    return {
      success: false,
      projectType: 'unknown',
      command: '',
      output: '',
      durationMs: Date.now() - startMs,
      error: `Directory not found: ${buildDir}`,
    };
  }

  const projectType = detectProjectType(buildDir);

  let cmd: string;
  let args: string[];

  if (input.command) {
    // Custom command: split on first space
    const parts = input.command.split(/\s+/);
    cmd = parts[0]!;
    args = parts.slice(1);
  } else {
    const defaultCmd = defaultBuildCommand(projectType, profile);
    if (!defaultCmd) {
      return {
        success: false,
        projectType,
        command: '',
        output: '',
        durationMs: Date.now() - startMs,
        error: `Cannot auto-detect build command for project type '${projectType}'. Use 'command' parameter.`,
      };
    }
    cmd = defaultCmd.cmd;
    args = defaultCmd.args;
  }

  const fullCommand = `${cmd} ${args.join(' ')}`;

  try {
    const stdout = execFileSync(cmd, args, {
      cwd: buildDir,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES * 4,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const output =
      stdout.length > MAX_OUTPUT_BYTES
        ? stdout.slice(-MAX_OUTPUT_BYTES) + '\n... (showing last portion)'
        : stdout;

    return {
      success: true,
      projectType,
      command: fullCommand,
      output,
      durationMs: Date.now() - startMs,
    };
  } catch (err: unknown) {
    const execErr = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    const combined = [execErr.stdout ?? '', execErr.stderr ?? ''].join('\n').trim();
    const output =
      combined.length > MAX_OUTPUT_BYTES
        ? combined.slice(-MAX_OUTPUT_BYTES) + '\n... (showing last portion)'
        : combined;

    return {
      success: false,
      projectType,
      command: fullCommand,
      output,
      durationMs: Date.now() - startMs,
      error: `Build failed with exit code ${execErr.status ?? 1}`,
    };
  }
}
