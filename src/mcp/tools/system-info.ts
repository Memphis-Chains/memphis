import { arch, cpus, freemem, hostname, platform, totalmem, uptime } from 'node:os';

import { loadConfig } from '../../infra/config/env.js';
import { getRustEmbedAdapterStatus } from '../../infra/storage/rust-embed-adapter.js';
import { getRustVaultAdapterStatus } from '../../infra/storage/rust-vault-adapter.js';

export interface SystemInfoOutput {
  memphisVersion: string;
  hostname: string;
  platform: string;
  arch: string;
  cpuCount: number;
  cpuModel: string;
  totalMemoryMb: number;
  freeMemoryMb: number;
  uptimeSeconds: number;
  nodeVersion: string;
  rustChainEnabled: boolean;
  vaultBridgeAvailable: boolean;
  embedBridgeAvailable: boolean;
}

export function runMemphisSystemInfo(): SystemInfoOutput {
  const config = loadConfig();
  const cpuList = cpus();
  const vaultStatus = getRustVaultAdapterStatus(process.env);
  const embedStatus = getRustEmbedAdapterStatus(process.env);

  return {
    memphisVersion: process.env.npm_package_version ?? 'unknown',
    hostname: hostname(),
    platform: platform(),
    arch: arch(),
    cpuCount: cpuList.length,
    cpuModel: cpuList[0]?.model ?? 'unknown',
    totalMemoryMb: Math.round(totalmem() / 1024 / 1024),
    freeMemoryMb: Math.round(freemem() / 1024 / 1024),
    uptimeSeconds: Math.round(uptime()),
    nodeVersion: process.version,
    rustChainEnabled: config.RUST_CHAIN_ENABLED,
    vaultBridgeAvailable: vaultStatus.bridgeLoaded && vaultStatus.vaultApiAvailable,
    embedBridgeAvailable: embedStatus.bridgeLoaded && embedStatus.embedApiAvailable,
  };
}
