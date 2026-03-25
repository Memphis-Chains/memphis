/**
 * Matrix setup prerequisites checker.
 *
 * Checks:
 * 1. Docker is installed and running
 * 2. Required ports (8008, 8448) are available
 * 3. Sufficient RAM is available (4GB+)
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';

export interface PrereqCheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export interface SystemResources {
  dockerInstalled: boolean;
  dockerRunning: boolean;
  portsAvailable: number[];
  portsInUse: number[];
  totalRamMb: number;
}

const REQUIRED_PORTS = [8008, 8448];
const MIN_RAM_MB = 4096;

function checkDocker(): { installed: boolean; running: boolean } {
  try {
    // Check if docker command exists
    execSync('docker --version', { stdio: 'pipe' });
    const installed = true;

    // Check if docker daemon is running
    try {
      execSync('docker info', { stdio: 'pipe' });
      return { installed, running: true };
    } catch {
      return { installed, running: false };
    }
  } catch {
    return { installed: false, running: false };
  }
}

function checkPorts(): { available: number[]; inUse: number[] } {
  const available: number[] = [];
  const inUse: number[] = [];

  for (const port of REQUIRED_PORTS) {
    // Try to bind the port - if it succeeds, it's free
    try {
      const server = net.createServer();
      server.listen(port, '127.0.0.1');
      server.close();
      available.push(port);
    } catch {
      inUse.push(port);
    }
  }

  return { available, inUse };
}

function checkRam(): number {
  try {
    // Linux: read from /proc/meminfo
    if (fs.existsSync('/proc/meminfo')) {
      const content = fs.readFileSync('/proc/meminfo', 'utf8');
      const match = content.match(/MemTotal:\s+(\d+)\s+kB/);
      if (match) {
        return Math.floor(parseInt(match[1], 10) / 1024); // Convert kB to MB
      }
    }
    // macOS: use sysctl
    const output = execSync('sysctl -n hw.memsize', { encoding: 'utf8', stdio: 'pipe' });
    return Math.floor(parseInt(output.trim(), 10) / (1024 * 1024));
  } catch {
    return 0;
  }
}

export function checkPrereqs(): PrereqCheckResult {
  const result: PrereqCheckResult = {
    ok: true,
    errors: [],
    warnings: [],
  };

  // Docker check
  const docker = checkDocker();
  if (!docker.installed) {
    result.ok = false;
    result.errors.push('Docker is not installed. Install from: https://docs.docker.com/get-docker/');
  } else if (!docker.running) {
    result.ok = false;
    result.errors.push('Docker daemon is not running. Start Docker and try again.');
  }

  // Port check
  const portResult = checkPorts();
  if (portResult.inUse.length > 0) {
    result.ok = false;
    result.errors.push(
      `Ports ${portResult.inUse.join(', ')} are in use. ` +
        `Stop the service using these ports or choose different ports.`
    );
  }

  // RAM check
  const ramMb = checkRam();
  if (ramMb > 0 && ramMb < MIN_RAM_MB) {
    result.warnings.push(
      `System has ${ramMb}MB RAM. Memphis recommends at least ${MIN_RAM_MB}MB for Synapse.`
    );
  }

  return result;
}

export function printPrereqReport(result: PrereqCheckResult): void {
  if (result.ok) {
    console.log('✅ All prerequisites met');
    if (result.warnings.length > 0) {
      for (const warning of result.warnings) {
        console.log(`⚠️  ${warning}`);
      }
    }
  } else {
    console.log('❌ Prerequisites check failed:');
    for (const error of result.errors) {
      console.log(`  • ${error}`);
    }
    if (result.warnings.length > 0) {
      console.log('Warnings:');
      for (const warning of result.warnings) {
        console.log(`  • ${warning}`);
      }
    }
  }
}
