import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { TaskFn } from './scheduler.js';
import { getDataDir, getVaultPath } from '../../config/paths.js';
import { sendTelegramMessage } from '../../gateway/channels/telegram-send.js';

function ollamaHealthCheck(): { ok: boolean; detail?: string } {
  try {
    const output = execSync('curl -s http://localhost:11434/api/tags', {
      encoding: 'utf8',
      timeout: 5000,
    });
    const parsed = JSON.parse(output);
    if (parsed.models && Array.isArray(parsed.models)) {
      return { ok: true, detail: `Ollama healthy, ${parsed.models.length} models loaded` };
    }
    return { ok: false, detail: 'Ollama returned unexpected response' };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'Ollama health check failed',
    };
  }
}

function chainIntegrityCheck(): { ok: boolean; detail?: string } {
  // Chain integrity is checked via the existing chain adapter
  // For cron, we just verify the chain files exist and are readable
  try {
    const dataDir = getDataDir();
    const chainsDir = join(dataDir, 'chains');
    if (!existsSync(chainsDir)) {
      return { ok: false, detail: 'chains directory not found' };
    }

    // Check that we can list chain directories
    const chainTypes = ['decisions', 'cases', 'patterns', 'reflections'];
    let foundChains = 0;
    for (const chain of chainTypes) {
      const chainPath = join(chainsDir, chain);
      if (existsSync(chainPath)) {
        foundChains++;
      }
    }

    return { ok: true, detail: `${foundChains} chain type(s) present` };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'Chain integrity check failed',
    };
  }
}

function vaultStateCheck(): { ok: boolean; detail?: string } {
  try {
    const vaultPath = getVaultPath();
    if (!existsSync(vaultPath)) {
      return { ok: false, detail: 'vault directory not found' };
    }

    // Check vault is accessible (execSync will throw if not accessible)
    execSync(`ls -la "${vaultPath}"`, { encoding: 'utf8', stdio: 'ignore' });
    return { ok: true, detail: 'vault accessible' };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'vault state check failed',
    };
  }
}

function diskSpaceCheck(): { ok: boolean; detail?: string } {
  try {
    const dataDir = getDataDir();
    const output = execSync(`df -h "${dataDir}" | tail -1`, { encoding: 'utf8' });
    const parts = output.trim().split(/\s+/);
    if (parts.length >= 5) {
      const usedPercent = parseInt(parts[4], 10);
      if (usedPercent >= 95) {
        return { ok: false, detail: `Disk usage critical: ${usedPercent}% used` };
      }
      if (usedPercent >= 85) {
        return { ok: true, detail: `Disk usage warning: ${usedPercent}% used` };
      }
      return { ok: true, detail: `Disk usage OK: ${usedPercent}% used` };
    }
    return { ok: false, detail: 'Could not parse disk space output' };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'disk space check failed',
    };
  }
}

function caseIndexCheck(): { ok: boolean; detail?: string } {
  try {
    const dataDir = getDataDir();
    const caseIndexPath = join(dataDir, 'case-index.sqlite');
    if (!existsSync(caseIndexPath)) {
      return { ok: false, detail: 'case-index.sqlite not found' };
    }
    return { ok: true, detail: 'case-index.sqlite present' };
  } catch (error) {
    return {
      ok: false,
      detail: error instanceof Error ? error.message : 'case-index check failed',
    };
  }
}

async function sendAlert(message: string): Promise<void> {
  try {
    await sendTelegramMessage({
      message: `[Memphis Cron Alert] ${message}`,
      rawEnv: process.env,
      fetchImpl: fetch,
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Silently ignore alert failures
  }
}

export function create5MinTasks(): Array<{ id: string; fn: TaskFn }> {
  return [
    {
      id: 'ollama-health',
      fn: (): Promise<{ ok: boolean; detail?: string }> => {
        const result = ollamaHealthCheck();
        if (!result.ok) {
          void sendAlert(`Ollama health check failed: ${result.detail}`);
        }
        return Promise.resolve(result);
      },
    },
    {
      id: 'chain-integrity',
      fn: (): Promise<{ ok: boolean; detail?: string }> => {
        const result = chainIntegrityCheck();
        if (!result.ok) {
          void sendAlert(`Chain integrity check failed: ${result.detail}`);
        }
        return Promise.resolve(result);
      },
    },
  ];
}

export function create30MinTasks(): Array<{ id: string; fn: TaskFn }> {
  return [
    {
      id: 'vault-state',
      fn: (): Promise<{ ok: boolean; detail?: string }> => {
        const result = vaultStateCheck();
        if (!result.ok) {
          void sendAlert(`Vault state check failed: ${result.detail}`);
        }
        return Promise.resolve(result);
      },
    },
    {
      id: 'disk-space',
      fn: (): Promise<{ ok: boolean; detail?: string }> => {
        const result = diskSpaceCheck();
        if (!result.ok) {
          void sendAlert(`Disk space check failed: ${result.detail}`);
        }
        return Promise.resolve(result);
      },
    },
  ];
}

export function create24HTasks(): Array<{ id: string; fn: TaskFn }> {
  return [
    {
      id: 'case-index-rebuild',
      fn: (): Promise<{ ok: boolean; detail?: string }> => {
        const result = caseIndexCheck();
        if (!result.ok) {
          void sendAlert(`Case index check failed: ${result.detail}`);
        }
        return Promise.resolve(result);
      },
    },
  ];
}

export async function runAllHealthChecks(): Promise<{
  ollamaHealth: { ok: boolean; detail?: string };
  chainIntegrity: { ok: boolean; detail?: string };
  vaultState: { ok: boolean; detail?: string };
  diskSpace: { ok: boolean; detail?: string };
  caseIndex: { ok: boolean; detail?: string };
}> {
  return {
    ollamaHealth: ollamaHealthCheck(),
    chainIntegrity: chainIntegrityCheck(),
    vaultState: vaultStateCheck(),
    diskSpace: diskSpaceCheck(),
    caseIndex: caseIndexCheck(),
  };
}
