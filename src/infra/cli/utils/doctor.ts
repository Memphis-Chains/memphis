import { accessSync, constants, existsSync, readdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { commandExists } from './render.js';

type DoctorCheckLevel = 'pass' | 'fail' | 'warn';

type DoctorCheck = {
  id: string;
  title: string;
  level: DoctorCheckLevel;
  ok: boolean;
  required: boolean;
  detail: string;
  fix?: string;
  meta?: Record<string, unknown>;
};

const REQUIRED_ENV_KEYS = ['MEMPHIS_VAULT_PEPPER', 'DATABASE_URL', 'DEFAULT_PROVIDER'] as const;

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

function canWriteDirectory(path: string): boolean {
  try {
    accessSync(resolve(path), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const out: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

async function checkEndpointReachable(url: string, timeoutMs = 800): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(timeoutMs) });
    return response.status < 500;
  } catch {
    return false;
  }
}

export function printDoctorHuman(result: { ok: boolean; checks: DoctorCheck[] }): void {
  const icon = (level: DoctorCheckLevel): string => {
    if (level === 'pass') return '✓';
    if (level === 'warn') return '⚠';
    return '✗';
  };

  console.log(`memphis doctor: ${result.ok ? 'PASS' : 'FAIL'}`);
  for (const check of result.checks) {
    console.log(`${icon(check.level)} ${check.title}: ${check.detail}`);
    if (check.fix) console.log(`  fix: ${check.fix}`);
  }
}

export async function runDoctorChecks(): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  const rustVersionRaw = commandExists('cargo') ? execSync('cargo --version', { encoding: 'utf8' }).trim() : 'missing';
  const rustVersion = rustVersionRaw.split(' ').at(1) ?? '';
  const rustVersionOk = rustVersion !== '' && isVersionAtLeast(rustVersion, 1, 70);
  checks.push({
    id: 'rust-version',
    title: 'Rust version',
    level: rustVersionOk ? 'pass' : 'warn',
    ok: rustVersionOk,
    required: false,
    detail: rustVersionRaw === 'missing' ? 'cargo not found' : `detected ${rustVersionRaw}`,
    fix: 'Install or upgrade Rust: https://rustup.rs (minimum 1.70)',
    meta: { minimum: '1.70.0', detected: rustVersion || null },
  });

  const nodeVersionOk = isVersionAtLeast(process.version, 20, 0);
  checks.push({
    id: 'node-version',
    title: 'Node version',
    level: nodeVersionOk ? 'pass' : 'warn',
    ok: nodeVersionOk,
    required: false,
    detail: `detected ${process.version}`,
    fix: 'Upgrade Node.js to 20+ (recommended current LTS).',
    meta: { minimum: '20.0.0', detected: process.version },
  });

  const dataWritable = canWriteDirectory('data');
  const distWritable = canWriteDirectory('dist');
  checks.push({
    id: 'permissions',
    title: 'Write permissions',
    level: dataWritable && distWritable ? 'pass' : 'fail',
    ok: dataWritable && distWritable,
    required: true,
    detail: `data/: ${dataWritable ? 'writable' : 'not writable'}, dist/: ${distWritable ? 'writable' : 'not writable'}`,
    fix: 'Ensure current user has write access: chmod -R u+rw data dist',
    meta: { dataWritable, distWritable },
  });

  const envPath = resolve('.env');
  const envExists = existsSync(envPath);
  const envValues = parseEnvFile(envPath);
  const missingEnvKeys = REQUIRED_ENV_KEYS.filter((k) => !envValues[k] || envValues[k].length === 0);
  checks.push({
    id: 'env-file',
    title: '.env required keys',
    level: envExists && missingEnvKeys.length === 0 ? 'pass' : 'fail',
    ok: envExists && missingEnvKeys.length === 0,
    required: true,
    detail: envExists ? (missingEnvKeys.length === 0 ? 'all required keys are set' : `missing keys: ${missingEnvKeys.join(', ')}`) : '.env is missing',
    fix: 'Copy .env.example to .env and populate required keys.',
    meta: { envFilePresent: envExists, requiredKeys: REQUIRED_ENV_KEYS, missingKeys: missingEnvKeys },
  });

  const distPath = resolve('dist');
  const distExists = existsSync(distPath);
  const distEntries = distExists ? readdirSync(distPath) : [];
  checks.push({
    id: 'build-artifacts',
    title: 'Build artifacts',
    level: distExists && distEntries.length > 0 ? 'pass' : 'fail',
    ok: distExists && distEntries.length > 0,
    required: true,
    detail: distExists ? `dist/ contains ${distEntries.length} entries` : 'dist/ directory is missing',
    fix: 'Run npm run build to generate artifacts.',
    meta: { distExists, entries: distEntries.length },
  });

  const embedMode = process.env.RUST_EMBED_MODE ?? envValues.RUST_EMBED_MODE ?? 'local';
  const providerUrl = process.env.RUST_EMBED_PROVIDER_URL ?? envValues.RUST_EMBED_PROVIDER_URL;
  const endpointToCheck =
    embedMode === 'ollama'
      ? 'http://127.0.0.1:11434/api/tags'
      : embedMode === 'provider' || embedMode === 'openai-compatible'
        ? providerUrl ?? null
        : null;
  const embedReachable = endpointToCheck ? await checkEndpointReachable(endpointToCheck) : true;
  checks.push({
    id: 'embedding-provider',
    title: 'Embedding provider endpoint',
    level: embedReachable ? 'pass' : 'warn',
    ok: embedReachable,
    required: false,
    detail: endpointToCheck ? `${endpointToCheck} is ${embedReachable ? 'reachable' : 'unreachable'}` : `mode=${embedMode} (no remote reachability check required)`,
    fix: endpointToCheck ? 'Start the provider service or correct endpoint URL in .env.' : undefined,
    meta: { embedMode, endpoint: endpointToCheck },
  });

  const port = Number(process.env.PORT ?? envValues.PORT ?? 3000);
  const mcpEndpoint = `http://127.0.0.1:${Number.isFinite(port) ? port : 3000}/health`;
  const mcpReachable = await checkEndpointReachable(mcpEndpoint);
  checks.push({
    id: 'mcp-service',
    title: 'MCP service/port availability',
    level: mcpReachable ? 'pass' : 'warn',
    ok: mcpReachable,
    required: false,
    detail: mcpReachable ? `service responds on port ${port}` : `no service detected on port ${port}`,
    fix: 'If MCP should be running, start it with memphis mcp serve.',
    meta: { port, reachable: mcpReachable },
  });

  return { ok: checks.every((check) => !check.required || check.level === 'pass'), checks };
}
