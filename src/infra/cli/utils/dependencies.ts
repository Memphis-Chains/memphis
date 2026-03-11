import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { AppError, errorTemplates } from '../../../core/errors.js';

export type DependencyCheck = {
  id: 'node-version' | 'rust-toolchain' | 'ollama';
  title: string;
  level: 'pass' | 'warn' | 'fail';
  ok: boolean;
  required: boolean;
  detail: string;
  fix?: string;
  meta?: Record<string, unknown>;
};

type CommandRunner = (command: string, args: string[]) => string;

const defaultCommandRunner: CommandRunner = (command, args) =>
  execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

function parseVersion(raw: string): { major: number; minor: number; patch: number } | null {
  const normalized = raw.trim().replace(/^v/, '');
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function isVersionAtLeast(raw: string, minMajor: number, minMinor: number): boolean {
  const parsed = parseVersion(raw);
  if (!parsed) return false;
  if (parsed.major !== minMajor) return parsed.major > minMajor;
  return parsed.minor >= minMinor;
}

function getEmbedMode(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return (rawEnv.RUST_EMBED_MODE ?? '').trim().toLowerCase();
}

function isBuildFromSource(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  return (rawEnv.MEMPHIS_BUILD_FROM_SOURCE ?? '').trim().toLowerCase() === 'true';
}

export function checkNodeVersion(version = process.version): DependencyCheck {
  const ok = isVersionAtLeast(version, 18, 0);
  return {
    id: 'node-version',
    title: 'Node version',
    level: ok ? 'pass' : 'fail',
    ok,
    required: true,
    detail: `detected ${version}`,
    fix: 'Install Node.js 18+ and reopen the shell.',
    meta: { minimum: '18.0.0', detected: version },
  };
}

export function checkRustToolchain(
  commandRunner: CommandRunner = defaultCommandRunner,
  rawEnv: NodeJS.ProcessEnv = process.env,
): DependencyCheck {
  const required = isBuildFromSource(rawEnv);
  try {
    const cargo = commandRunner('cargo', ['--version']);
    const rustc = commandRunner('rustc', ['--version']);
    const cargoVersion = cargo.split(' ').at(1) ?? '';
    const ok = cargoVersion.length > 0 && isVersionAtLeast(cargoVersion, 1, 70);

    return {
      id: 'rust-toolchain',
      title: 'Rust toolchain',
      level: ok ? 'pass' : required ? 'fail' : 'warn',
      ok,
      required,
      detail: `${cargo}; ${rustc}`,
      fix: 'Install Rust via https://rustup.rs and ensure `cargo`/`rustc` are on PATH.',
      meta: { minimum: '1.70.0', cargo, rustc },
    };
  } catch (error) {
    const appError = new AppError(
      'CONFIG_ERROR',
      'Rust toolchain is missing from PATH.',
      500,
      { dependency: 'rust-toolchain' },
      'Install Rust via https://rustup.rs and load `$HOME/.cargo/env` in this shell.',
      error,
    );

    return {
      id: 'rust-toolchain',
      title: 'Rust toolchain',
      level: required ? 'fail' : 'warn',
      ok: false,
      required,
      detail: appError.message,
      fix: 'Install Rust via https://rustup.rs and load `$HOME/.cargo/env` in this shell.',
      meta: { dependency: 'rust-toolchain' },
    };
  }
}

export async function checkOllama(
  options: {
    rawEnv?: NodeJS.ProcessEnv;
    commandRunner?: CommandRunner;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<DependencyCheck> {
  const rawEnv = options.rawEnv ?? process.env;
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 800;
  const required = getEmbedMode(rawEnv) === 'ollama';
  const url = rawEnv.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434';
  const tagsUrl = `${url.replace(/\/$/, '')}/api/tags`;

  let binaryDetected = false;
  try {
    commandRunner('ollama', ['--version']);
    binaryDetected = true;
  } catch {
    const error = errorTemplates.missingOllama({ url, required, details: { binaryDetected } });
    return {
      id: 'ollama',
      title: 'Ollama',
      level: required ? 'fail' : 'warn',
      ok: false,
      required,
      detail: error.message,
      fix: error.suggestion,
      meta: error.details,
    };
  }

  try {
    const response = await fetchImpl(tagsUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ok = response.ok;

    if (!ok) {
      const error = errorTemplates.network({
        target: tagsUrl,
        message: `Ollama responded with HTTP ${response.status}.`,
        details: { binaryDetected, url: tagsUrl, status: response.status },
      });
      return {
        id: 'ollama',
        title: 'Ollama',
        level: required ? 'fail' : 'warn',
        ok: false,
        required,
        detail: error.message,
        fix: 'Start Ollama with `ollama serve` and verify `ollama list` works locally.',
        meta: error.details,
      };
    }

    return {
      id: 'ollama',
      title: 'Ollama',
      level: 'pass',
      ok: true,
      required,
      detail: `binary detected and ${tagsUrl} is reachable`,
      fix: required
        ? 'Pull the required embedding model with `ollama pull <model>` if not already present.'
        : undefined,
      meta: { binaryDetected, url: tagsUrl },
    };
  } catch (error) {
    const appError = errorTemplates.network({
      target: tagsUrl,
      message: `Ollama binary is installed but ${tagsUrl} is unreachable.`,
      details: { binaryDetected, url: tagsUrl },
      cause: error,
    });
    return {
      id: 'ollama',
      title: 'Ollama',
      level: required ? 'fail' : 'warn',
      ok: false,
      required,
      detail: appError.message,
      fix: 'Start Ollama with `ollama serve` and verify the local API on port 11434.',
      meta: appError.details,
    };
  }
}

export async function checkDependencies(
  options: {
    rawEnv?: NodeJS.ProcessEnv;
    commandRunner?: CommandRunner;
    fetchImpl?: typeof fetch;
    includeOllama?: boolean;
  } = {},
): Promise<DependencyCheck[]> {
  const rawEnv = options.rawEnv ?? process.env;
  const checks: DependencyCheck[] = [
    checkNodeVersion(),
    checkRustToolchain(options.commandRunner, rawEnv),
  ];

  if (options.includeOllama !== false) {
    checks.push(
      await checkOllama({
        rawEnv,
        commandRunner: options.commandRunner,
        fetchImpl: options.fetchImpl,
      }),
    );
  }

  return checks;
}

export function hasEnvFile(path = '.env'): boolean {
  return existsSync(resolve(path));
}
