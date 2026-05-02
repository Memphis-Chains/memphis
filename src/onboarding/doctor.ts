import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { getDataDir } from '../config/paths.js';
import { checkNodeVersion, checkRustToolchain } from '../infra/cli/utils/dependencies.js';
import { resolveRustBridgePath } from '../infra/runtime/install-root.js';
import {
  loadPlatformAwareBridge,
  resolveBridgeContract,
  hasRequiredBridgeExports,
} from '../infra/storage/napi-contract.js';

const CHAIN_BRIDGE_ALIASES = {
  chain_append: ['chain_append', 'chainAppend'],
  chain_validate: ['chain_validate', 'chainValidate'],
  chain_query: ['chain_query', 'chainQuery'],
} as const;

type ChainBridgeKey = keyof typeof CHAIN_BRIDGE_ALIASES;

export type DoctorResult = {
  rust: { status: 'PASS' | 'FAIL'; message: string };
  node: { status: 'PASS' | 'FAIL'; message: string };
  bridge: { status: 'PASS' | 'FAIL'; message: string; details?: { exports: string[] } };
  vault: { status: 'PASS' | 'FAIL'; message: string };
  chains: { status: 'PASS' | 'FAIL'; message: string };
};

export class Doctor {
  async runDiagnostics(): Promise<DoctorResult> {
    const rust = checkRustToolchain();
    const node = checkNodeVersion();

    return {
      rust: { status: rust.ok ? 'PASS' : 'FAIL', message: rust.detail },
      node: { status: node.ok ? 'PASS' : 'FAIL', message: node.detail },
      bridge: this.checkBridge(),
      vault: this.checkVault(),
      chains: this.checkChains(),
    };
  }

  private checkBridge(): DoctorResult['bridge'] {
    const bridgePath = resolveRustBridgePath();
    const bridge = loadPlatformAwareBridge(bridgePath);
    const resolution = resolveBridgeContract(bridge, CHAIN_BRIDGE_ALIASES);

    if (!resolution.bridgeLoaded) {
      return {
        status: 'FAIL',
        message: `Bridge not loaded from ${bridgePath} — run: npm run build`,
        details: { exports: [] },
      };
    }

    const required: ChainBridgeKey[] = ['chain_append', 'chain_validate', 'chain_query'];
    if (!hasRequiredBridgeExports(resolution, required)) {
      return {
        status: 'FAIL',
        message: `Bridge missing required exports: ${resolution.missing.join(', ')}`,
        details: { exports: Object.keys(resolution.resolved) },
      };
    }

    return {
      status: 'PASS',
      message: 'bridge exports loaded',
      details: { exports: Object.keys(resolution.resolved) },
    };
  }

  private checkVault(): DoctorResult['vault'] {
    const dataDir = getDataDir(process.env);
    const vaultDir = resolve(dataDir, 'vault');
    if (existsSync(vaultDir)) {
      return { status: 'PASS', message: 'vault directory exists' };
    }
    return { status: 'FAIL', message: 'vault directory not found — run: memphis vault init' };
  }

  private checkChains(): DoctorResult['chains'] {
    const dataDir = getDataDir(process.env);
    const chainsDir = resolve(dataDir, 'chains');
    if (existsSync(chainsDir)) {
      return { status: 'PASS', message: 'chains directory exists' };
    }
    return { status: 'FAIL', message: 'chains directory not found' };
  }
}
