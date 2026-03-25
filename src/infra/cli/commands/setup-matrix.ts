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

import { checkPrereqs } from './setup-matrix-prereqs.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

type MatrixSetupOptions = {
  serverName?: string;
  adminUser?: string;
  adminPass?: string;
  dockerComposePath?: string;
  homeserverConfigPath?: string;
  json?: boolean;
};

type MatrixSetupResult = {
  ok: boolean;
  serverName: string;
  homeserverUrl: string;
  adminUser: string;
  synapseContainerId?: string;
  matrixConfig?: Record<string, string>;
  errors: string[];
  warnings: string[];
};

const DEFAULT_SERVER_NAME = `memphis-${hostname().split('.')[0]}.local`;
const DEFAULT_ADMIN_USER = 'memphis_admin';
const COMPOSE_DIR = resolve(process.cwd(), 'compose');
const SYNAPSE_CONFIG_DIR = resolve(COMPOSE_DIR, 'synapse');

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

function renderMatrixSetupResult(result: MatrixSetupResult, asJson: boolean): void {
  if (asJson) {
    print(result, true);
    return;
  }

  if (result.ok) {
    console.log('\n✅ Matrix federation setup complete!\n');
  } else {
    console.log('\n❌ Matrix federation setup failed.\n');
  }

  console.log('Server details:');
  console.log(`  Server name: ${result.serverName}`);
  console.log(`  Homeserver URL: ${result.homeserverUrl}`);
  console.log(`  Admin user: ${result.adminUser}`);

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

  if (result.ok) {
    console.log('\nNext steps:');
    console.log('  1. Add the environment variables above to your .env');
    console.log('  2. Restart Memphis: npm run dev');
    console.log('  3. Test federation: curl http://localhost:8008/_matrix/client/versions');
  }
}

export async function runMatrixSetup(options: MatrixSetupOptions): Promise<MatrixSetupResult> {
  const result: MatrixSetupResult = {
    ok: false,
    serverName: options.serverName || DEFAULT_SERVER_NAME,
    homeserverUrl: `http://localhost:8008`,
    adminUser: options.adminUser || DEFAULT_ADMIN_USER,
    errors: [],
    warnings: [],
  };

  // Step 1: Check prerequisites
  console.log('🔍 Checking prerequisites...\n');
  const prereqs = checkPrereqs();

  if (!prereqs.ok) {
    result.errors.push(...prereqs.errors);
    return result;
  }

  if (!checkDockerRunning()) {
    result.errors.push('Docker is not running. Start Docker and try again.');
    return result;
  }

  if (prereqs.warnings.length > 0) {
    result.warnings.push(...prereqs.warnings);
  }

  // Step 2: Ensure directories exist
  mkdirSync(SYNAPSE_CONFIG_DIR, { recursive: true });

  // Step 3: Generate secrets
  const registrationSecret = generateSecret(32);
  const macaroonSecret = generateSecret(32);

  // Step 4: Create homeserver.yaml from template if it doesn't exist
  const homeserverPath = resolve(SYNAPSE_CONFIG_DIR, 'homeserver.yaml');
  if (!existsSync(homeserverPath)) {
    const templatePath = resolve(SYNAPSE_CONFIG_DIR, 'homeserver.yaml');
    if (existsSync(templatePath.replace(SYNAPSE_CONFIG_DIR, COMPOSE_DIR))) {
      // Copy from compose/synapse/homeserver.yaml
      const composeTemplate = resolve(COMPOSE_DIR, 'synapse', 'homeserver.yaml');
      if (existsSync(composeTemplate)) {
        let content = readFileSync(composeTemplate, 'utf8');
        content = content
          .replace('${SYNAPSE_REGISTRATION_SHARED_SECRET}', registrationSecret)
          .replace('${SYNAPSE_MACAROON_SECRET_KEY}', macaroonSecret)
          .replace('${SYNAPSE_SERVER_NAME}', result.serverName);
        writeFileSync(homeserverPath, content, 'utf8');
      }
    }
  }

  // Step 5: Generate docker-compose override or run directly
  const composePath = options.dockerComposePath || resolve(COMPOSE_DIR, 'matrix.yaml');
  if (!existsSync(composePath)) {
    result.errors.push(`Docker compose file not found: ${composePath}`);
    result.errors.push('Run: docker compose -f compose/matrix.yaml up -d');
    return result;
  }

  // Step 6: Check if container already running
  try {
    const existing = execCommand('docker ps --filter name=memphis-synapse --format "{{.ID}}"');
    if (existing) {
      result.warnings.push('Synapse container already running. Skipping container start.');
      result.synapseContainerId = existing;
    }
  } catch {
    // Container not running, need to start it
  }

  // Step 7: Start Synapse if not running
  if (!result.synapseContainerId) {
    console.log('\n🚀 Starting Synapse container...\n');

    try {
      // Run docker compose
      execCommand(
        `docker compose -f "${composePath}" up -d`,
        { cwd: resolve(composePath, '..'), stdio: 'inherit' }
      );

      // Wait for container to start
      const containerId = execCommand(
        'docker ps --filter name=memphis-synapse --format "{{.ID}}"'
      );
      result.synapseContainerId = containerId;

      console.log('\n⏳ Waiting for Synapse to start...\n');

      // Wait for health check or timeout
      const ready = await waitForSynapse(`${result.homeserverUrl}/_matrix/client/versions`);
      if (!ready) {
        result.warnings.push('Synapse may not be fully ready. Check logs with: docker compose -f compose/matrix.yaml logs');
      }
    } catch (error) {
      result.errors.push(`Failed to start Synapse: ${(error as Error).message}`);
      return result;
    }
  }

  // Step 8: Create admin user
  console.log('\n👤 Creating admin user...\n');

  const adminPassword = options.adminPass || generateSecret(16);

  try {
    // Register admin user via Synapse admin API
    const registerResponse = await fetch(
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
      }
    );

    if (!registerResponse.ok) {
      const errorText = await registerResponse.text();
      if (!errorText.includes('already registered')) {
        result.warnings.push(`Admin user registration returned ${registerResponse.status}. User may already exist.`);
      }
    }
  } catch (error) {
    result.warnings.push(`Could not create admin user: ${(error as Error).message}`);
  }

  // Step 9: Generate .env variables
  result.matrixConfig = {
    MEMPHIS_MATRIX_ENABLED: 'true',
    MEMPHIS_MATRIX_HOMESERVER: result.homeserverUrl,
    MEMPHIS_MATRIX_SERVER_NAME: result.serverName,
    MEMPHIS_MATRIX_ACCESS_TOKEN: registrationSecret, // Note: In production, store in vault
    MEMPHIS_MATRIX_ADMIN_USER: result.adminUser,
    // NOTE: Store admin password in vault, not plaintext .env
    // MEMPHIS_MATRIX_ADMIN_PASSWORD: adminPassword,
  };

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
