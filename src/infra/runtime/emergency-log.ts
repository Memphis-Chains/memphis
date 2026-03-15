import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface EmergencyLogWriteResult {
  path: string;
  fallbackPathUsed: boolean;
}

const EMERGENCY_MAX_BYTES = 10 * 1024 * 1024;
const EMERGENCY_ROTATE_KEEP = 3;

type ResolveOptions = {
  homeDir?: string;
  cwdPath?: string;
  includeCwdFallback?: boolean;
  explicitPaths?: string[];
};

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (typeof raw !== 'string') return fallback;
  return raw.trim().toLowerCase() === 'true';
}

export function resolveEmergencyLogCandidates(
  rawEnv: NodeJS.ProcessEnv = process.env,
  options: ResolveOptions = {},
): string[] {
  if (Array.isArray(options.explicitPaths) && options.explicitPaths.length > 0) {
    return options.explicitPaths.map((candidate) => resolve(candidate));
  }

  const home = options.homeDir ?? rawEnv.HOME;
  const includeCwd = options.includeCwdFallback ?? true;
  const cwd = options.cwdPath ?? process.cwd();
  const candidates = ['/var/lib/memphis/emergency.log', '/opt/memphis/data/emergency.log'];

  if (home && home.trim().length > 0) {
    candidates.push(resolve(home, '.memphis', 'emergency.log'));
  }

  if (includeCwd) {
    candidates.push(resolve(cwd, 'emergency.log'));
  }

  return candidates;
}

function rotateFile(path: string): void {
  if (!existsSync(path)) return;
  let size = 0;
  try {
    size = statSync(path).size;
  } catch {
    return;
  }
  if (size <= EMERGENCY_MAX_BYTES) return;

  for (let i = EMERGENCY_ROTATE_KEEP - 1; i >= 1; i -= 1) {
    const src = `${path}.${i}`;
    const dst = `${path}.${i + 1}`;
    if (existsSync(src)) {
      renameSync(src, dst);
    }
  }

  renameSync(path, `${path}.1`);
}

function canWriteEmergencyLog(candidate: string): boolean {
  try {
    mkdirSync(dirname(candidate), { recursive: true });
    rotateFile(candidate);
    if (!existsSync(candidate)) {
      appendFileSync(candidate, '', { encoding: 'utf8', mode: 0o600, flag: 'a' });
    }
    chmodSync(candidate, 0o600);
    return true;
  } catch {
    return false;
  }
}

export function resolveEmergencyLogPath(
  rawEnv: NodeJS.ProcessEnv = process.env,
  options: ResolveOptions = {},
): EmergencyLogWriteResult | null {
  const candidates = resolveEmergencyLogCandidates(rawEnv, options);
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i]!;
    if (canWriteEmergencyLog(candidate)) {
      return {
        path: candidate,
        fallbackPathUsed: i > 0,
      };
    }
  }
  return null;
}

export function writeEmergencyLog(
  message: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
  options: ResolveOptions = {},
): EmergencyLogWriteResult | null {
  const candidates = resolveEmergencyLogCandidates(rawEnv, options);
  const resolved = resolveEmergencyLogPath(rawEnv, options);
  if (!resolved) {
    return null;
  }

  const line = `[${new Date().toISOString()}] ${message}\n`;
  appendFileSync(resolved.path, line, { encoding: 'utf8', mode: 0o600, flag: 'a' });
  if (resolved.fallbackPathUsed) {
    const primary = candidates[0] ?? '/var/lib/memphis/emergency.log';
    process.stderr.write(`[memphis] FallbackPathUsed primary=${primary} used=${resolved.path}\n`);
  }
  return resolved;
}

export function inStrictMode(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  return parseBool(rawEnv.MEMPHIS_STRICT_MODE, false);
}

export function isSafeMode(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  return parseBool(rawEnv.MEMPHIS_SAFE_MODE, false);
}

export function describeEmergencyLogFallback(primaryPath: string, usedPath: string): string {
  return `FallbackPathUsed primary=${primaryPath} used=${usedPath}`;
}

export function emergencyFallbackTag(message: string): string {
  return `[ALERT_FALLBACK] ${message}`;
}

export function emergencyLogDir(pathname: string): string {
  return dirname(pathname);
}

export function defaultPrimaryEmergencyPath(): string {
  return '/var/lib/memphis/emergency.log';
}

export function defaultSecondaryEmergencyPath(): string {
  return '/opt/memphis/data/emergency.log';
}

export function resolveDefaultHomeEmergencyPath(home: string): string {
  return join(home, '.memphis', 'emergency.log');
}
