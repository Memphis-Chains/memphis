/**
 * Memphis Matrix Federation Setup Wizard
 *
 * Sets up self-hosted Synapse for Memphis federation.
 *
 * Usage:
 *   memphis setup matrix [--server-name <name>] [--admin-user <user>] [--admin-pass <pass>]
 *
 * This wizard:
 * 1. Checks prerequisites (Docker, ports, RAM)
 * 2. Generates secure configuration
 * 3. Starts Synapse container
 * 4. Creates admin user via registration API
 * 5. Stores credentials in vault
 */

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';

import {
  probeVaultCipherCycle,
  storeVaultSecret,
} from '../../../security/vault-boundary.js';
import type { CliContext } from '../context.js';
import { checkPrereqs } from './setup-matrix-prereqs.js';
import { print } from '../utils/render.js';

type MatrixSetupOptions = {
  serverName?: string;
  adminUser?: string;
  adminPass?: string;
  dockerComposePath?: string;
  homeserverConfigPath?: string;
  json?: boolean;
  deps?: Partial<MatrixSetupDeps>;
};

type MatrixSetupResult = {
  ok: boolean;
  pilotReady: boolean;
  serverName: string;
  homeserverUrl: string;
  adminUser: string;
  synapseContainerId?: string;
  matrixConfig?: Record<string, string>;
  storedVaultKeys: string[];
  manualSteps: string[];
  errors: string[];
  warnings: string[];
};

type MatrixSetupDeps = {
  checkPrereqs: typeof checkPrereqs;
  checkDockerRunning: typeof checkDockerRunning;
  execCommand: typeof execCommand;
  waitForSynapse: typeof waitForSynapse;
  fetchFn: typeof fetch;
  storeVaultSecret: typeof storeVaultSecret;
  probeVaultCipherCycle: typeof probeVaultCipherCycle;
};

const DEFAULT_SERVER_NAME = `memphis-${hostname().split('.')[0]}.local`;
const DEFAULT_ADMIN_USER = 'memphis_admin';
const COMPOSE_DIR = resolve(process.cwd(), 'compose');
const SYNAPSE_CONFIG_DIR = resolve(COMPOSE_DIR, 'synapse');
const SYNAPSE_TEMPLATE_PATH = resolve(SYNAPSE_CONFIG_DIR, 'homeserver.yaml');
const SYNAPSE_GENERATED_PATH = resolve(SYNAPSE_CONFIG_DIR, 'homeserver.generated.yaml');

function generateSecret(length = 32): string {
  return randomBytes(length).toString('hex');
}

function execCommand(cmd: string, options: { cwd?: string; stdio?: 'inherit' | 'pipe' } = {}): string {
  try {
    return execSync(cmd, {
      cwd: options.cwd || process.cwd(),
      stdio: options.stdio || 'pipe',
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    const err = error as { message?: string; stderr?: string };
    throw new Error(`Command failed: ${cmd}\n${err.stderr || err.message || 'Unknown error'}`);
  }
}

function checkDockerRunning(): boolean {
  try {
    execCommand('docker info', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function waitForSynapse(url: string, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolve) => {
    const check = async () => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (response.ok) {
          resolve(true);
          return;
        }
      } catch {
        // Not ready yet
      }
      if (Date.now() - start > timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(check, 1000);
    };
    check();
  });
}

function matrixSetupDeps(options: MatrixSetupOptions): MatrixSetupDeps {
  return {
    checkPrereqs,
    checkDockerRunning,
    execCommand,
    waitForSynapse,
    fetchFn: fetch,
    storeVaultSecret,
    probeVaultCipherCycle,
    ...options.deps,
  };
}

function matrixVaultKey(name: string): string {
  return `MEMPHIS_MATRIX_${name}`;
}

function logProgress(enabled: boolean, message: string): void {
  if (enabled) {
    console.log(message);
  }
}

function renderMatrixSetupResult(result: MatrixSetupResult, asJson: boolean): void {
  if (asJson) {
    print(result, true);
    return;
  }

  if (result.ok && result.pilotReady) {
    console.log('\n✅ Matrix federation setup complete!\n');
  } else if (result.ok) {
    console.log('\n⚠️  Matrix federation setup completed with manual follow-up required.\n');
  } else {
    console.log('\n❌ Matrix federation setup failed.\n');
  }

  console.log('Server details:');
  console.log(`  Server name: ${result.serverName}`);
  console.log(`  Homeserver URL: ${result.homeserverUrl}`);
  console.log(`  Admin user: ${result.adminUser}`);

  if (result.storedVaultKeys.length > 0) {
    console.log('\nStored in vault:');
    for (const key of result.storedVaultKeys) {
      console.log(`  • ${key}`);
    }
  }

  if (result.matrixConfig) {
    console.log('\nAdd to your .env:');
    for (const [key, value] of Object.entries(result.matrixConfig)) {
      console.log(`  ${key}=${value}`);
    }
  }

  if (result.errors.length > 0) {
    console.log('\nErrors:');
    for (const error of result.errors) {
      console.log(`  • ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of result.warnings) {
      console.log(`  • ${warning}`);
    }
  }

  if (result.manualSteps.length > 0) {
    console.log('\nManual steps:');
    for (const step of result.manualSteps) {
      console.log(`  ${step}`);
    }
  }

  if (result.ok) {
    console.log('\nNext steps:');
    console.log('  1. Add the environment variables above to your .env');
    if (result.pilotReady) {
      console.log('  2. Restart Memphis: npm run dev');
      console.log('  3. Test federation readiness: npm run -s cli -- health --json');
    } else {
      console.log('  2. Complete the manual steps above');
      console.log('  3. Re-run memphis setup matrix --json or memphis doctor --json');
    }
  }
}

export async function runMatrixSetup(options: MatrixSetupOptions): Promise<MatrixSetupResult> {
  const deps = matrixSetupDeps(options);
  const showProgress = !options.json;
  const result: MatrixSetupResult = {
    ok: false,
    pilotReady: false,
    serverName: options.serverName || DEFAULT_SERVER_NAME,
    homeserverUrl: `http://localhost:8008`,
    adminUser: options.adminUser || DEFAULT_ADMIN_USER,
    storedVaultKeys: [],
    manualSteps: [],
    errors: [],
    warnings: [],
  };

  // Step 1: Check prerequisites
  logProgress(showProgress, '🔍 Checking prerequisites...\n');
  const prereqs = deps.checkPrereqs();

  if (!prereqs.ok) {
    result.errors.push(...prereqs.errors);
    return result;
  }

  if (!deps.checkDockerRunning()) {
    result.errors.push('Docker is not running. Start Docker and try again.');
    return result;
  }

  if (prereqs.warnings.length > 0) {
    result.warnings.push(...prereqs.warnings);
  }

  const vaultProbe = deps.probeVaultCipherCycle(
    { surface: 'cli', command: 'setup matrix' },
    process.env,
  );
  if (!vaultProbe.ok) {
    result.errors.push(
      'Matrix pilot setup requires an initialized local vault. Run: memphis vault init --passphrase <secret> --recovery-question <q> --recovery-answer <a>',
    );
    return result;
  }

  // Step 2: Ensure directories exist
  const homeserverPath = options.homeserverConfigPath || SYNAPSE_GENERATED_PATH;
  const synapseConfigDir = resolve(homeserverPath, '..');
  mkdirSync(synapseConfigDir, { recursive: true });

  // Step 3: Generate secrets
  const registrationSecret = generateSecret(32);
  const macaroonSecret = generateSecret(32);
  const adminPassword = options.adminPass || generateSecret(16);

  // Step 4: Materialize homeserver config from tracked template
  if (!existsSync(SYNAPSE_TEMPLATE_PATH)) {
    result.errors.push(`Synapse template not found: ${SYNAPSE_TEMPLATE_PATH}`);
    return result;
  }

  let content = readFileSync(SYNAPSE_TEMPLATE_PATH, 'utf8');
  content = content
    .replace(/^server_name:\s*".*"$/m, `server_name: "${result.serverName}"`)
    .replace('${SYNAPSE_REGISTRATION_SHARED_SECRET}', registrationSecret)
    .replace('${SYNAPSE_MACAROON_SECRET_KEY}', macaroonSecret)
    .replace('${SYNAPSE_SERVER_NAME}', result.serverName);
  writeFileSync(homeserverPath, content, 'utf8');

  // Step 5: Generate docker-compose override or run directly
  const composePath = options.dockerComposePath || resolve(COMPOSE_DIR, 'matrix.yaml');
  if (!existsSync(composePath)) {
    result.errors.push(`Docker compose file not found: ${composePath}`);
    result.errors.push('Run: docker compose -f compose/matrix.yaml up -d');
    return result;
  }

  // Step 6: Check if container already running
  try {
    const existing = deps.execCommand('docker ps --filter name=memphis-synapse --format "{{.ID}}"');
    if (existing) {
      result.warnings.push('Synapse container already running. Skipping container start.');
      result.synapseContainerId = existing;
    }
  } catch {
    // Container not running, need to start it
  }

  // Step 7: Start Synapse if not running
  if (!result.synapseContainerId) {
    logProgress(showProgress, '\n🚀 Starting Synapse container...\n');

    try {
      // Run docker compose
      deps.execCommand(
        `docker compose -f "${composePath}" up -d`,
        { cwd: resolve(composePath, '..'), stdio: 'inherit' }
      );

      // Wait for container to start
      const containerId = deps.execCommand(
        'docker ps --filter name=memphis-synapse --format "{{.ID}}"'
      );
      result.synapseContainerId = containerId;

      logProgress(showProgress, '\n⏳ Waiting for Synapse to start...\n');

      // Wait for health check or timeout
      const ready = await deps.waitForSynapse(`${result.homeserverUrl}/_matrix/client/versions`);
      if (!ready) {
        result.warnings.push('Synapse may not be fully ready. Check logs with: docker compose -f compose/matrix.yaml logs');
      }
    } catch (error) {
      result.errors.push(`Failed to start Synapse: ${(error as Error).message}`);
      return result;
    }
  }

  // Step 8: Create admin user
  logProgress(showProgress, '\n👤 Creating admin user...\n');

  let accessToken: string | undefined;

  try {
    // Register admin user via Synapse admin API
    const registerResponse = await deps.fetchFn(
      `${result.homeserverUrl}/_matrix/client/v3/register`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${registrationSecret}`,
        },
        body: JSON.stringify({
          username: result.adminUser,
          password: adminPassword,
          admin: true,
          initial_device_display_name: 'Memphis Matrix Admin',
        }),
      },
    );

    if (!registerResponse.ok) {
      const errorText = await registerResponse.text();
      if (!errorText.includes('already registered')) {
        result.warnings.push(`Admin user registration returned ${registerResponse.status}. User may already exist.`);
      }
    } else {
      try {
        const data = (await registerResponse.json()) as { access_token?: string };
        if (typeof data.access_token === 'string' && data.access_token.trim().length > 0) {
          accessToken = data.access_token;
        }
      } catch {
        result.warnings.push('Admin registration succeeded but did not return a machine-readable response.');
      }
    }

    if (!accessToken) {
      const loginResponse = await deps.fetchFn(
        `${result.homeserverUrl}/_matrix/client/v3/login`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'm.login.password',
            identifier: {
              type: 'm.id.user',
              user: result.adminUser,
            },
            password: adminPassword,
            initial_device_display_name: 'Memphis Matrix Admin',
          }),
        },
      );

      if (loginResponse.ok) {
        try {
          const data = (await loginResponse.json()) as { access_token?: string };
          if (typeof data.access_token === 'string' && data.access_token.trim().length > 0) {
            accessToken = data.access_token;
          }
        } catch {
          result.warnings.push('Admin login succeeded but did not return a machine-readable access token.');
        }
      } else {
        result.warnings.push(`Could not acquire Matrix access token automatically (login returned ${loginResponse.status}).`);
      }
    }
  } catch (error) {
    result.warnings.push(`Could not create admin user: ${(error as Error).message}`);
  }

  // Step 9: Store pilot secrets in vault
  const secrets: Array<{ key: string; value: string }> = [
    { key: matrixVaultKey('REGISTRATION_SHARED_SECRET'), value: registrationSecret },
    { key: matrixVaultKey('ADMIN_PASSWORD'), value: adminPassword },
  ];
  if (accessToken) {
    secrets.push({ key: matrixVaultKey('ACCESS_TOKEN'), value: accessToken });
  }

  try {
    for (const secret of secrets) {
      deps.storeVaultSecret(
        secret.key,
        secret.value,
        { surface: 'cli', command: 'setup matrix' },
        process.env,
      );
      result.storedVaultKeys.push(secret.key);
    }
  } catch (error) {
    result.errors.push(
      `Failed to store Matrix pilot secrets in vault: ${error instanceof Error ? error.message : String(error)}`,
    );
    return result;
  }

  // Step 10: Generate truthful runtime config output
  result.matrixConfig = {
    MEMPHIS_MATRIX_ENABLED: 'true',
    MEMPHIS_MATRIX_HOMESERVER: result.homeserverUrl,
    MEMPHIS_MATRIX_SERVER_NAME: result.serverName,
    MEMPHIS_MATRIX_ADMIN_USER: result.adminUser,
    MEMPHIS_MATRIX_TRUST_MODE: 'trusted-pilot',
  };
  if (accessToken) {
    result.matrixConfig.MEMPHIS_MATRIX_ACCESS_TOKEN = `VAULT:${matrixVaultKey('ACCESS_TOKEN')}`;
    result.pilotReady = true;
  } else {
    result.warnings.push(
      'Matrix pilot setup did not acquire an access token automatically. Federation readiness stays unavailable until a real token is stored in vault.',
    );
    result.manualSteps.push(
      `1. Acquire a Matrix access token for ${result.adminUser} from ${result.homeserverUrl}.`,
    );
    result.manualSteps.push(
      `2. Store it with: memphis vault add --key ${matrixVaultKey('ACCESS_TOKEN')} --value '<token>'`,
    );
    result.manualSteps.push(
      `3. Add MEMPHIS_MATRIX_ACCESS_TOKEN=VAULT:${matrixVaultKey('ACCESS_TOKEN')} to your .env and restart Memphis.`,
    );
  }

  result.ok = true;
  return result;
}

export async function handleMatrixSetupCommand(context: CliContext): Promise<boolean> {
  const { json, serverName, adminUser, adminPass } = context.args;

  try {
    const result = await runMatrixSetup({
      serverName,
      adminUser,
      adminPass,
      json,
    });

    renderMatrixSetupResult(result, json || false);
    process.exitCode = result.ok ? 0 : 1;
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      print({ ok: false, error: message }, true);
    } else {
      console.error(`\n❌ Setup failed: ${message}\n`);
    }
    process.exitCode = 1;
    return true;
  }
}
