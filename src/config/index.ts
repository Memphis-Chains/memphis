/**
 * Memphis Config
 *
 * Default location: ~/.memphis/config.yaml
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import YAML from 'yaml';

import { ensureDir, getChainPath, getConfigPath, getDataDir } from './paths.js';

export const MEMPHIS_HOME = getDataDir();
export const CHAINS_PATH = getChainPath();
export const CONFIG_PATH = getConfigPath('config.yaml');

export interface MemphisConfig {
  version: string;
  providers: Array<{
    name: string;
    type: 'ollama' | 'minimax' | 'openai-compatible';
    priority: number;
    url?: string;
    apiKey?: string;
    model?: string;
    extraHeaders?: Record<string, string>;
  }>;
  embeddings: {
    backend: string;
    model: string;
  };
  gateway: {
    enabled: boolean;
    port: number;
    host: string;
    authToken?: string;
  };
  agent: {
    allowExec: boolean;
    allowFileWrite: boolean;
    blockedPaths: string[];
  };
  memory: {
    path: string;
    maxInlineBytes: number;
    autoEmbed: boolean;
  };
}

export function defaultConfig(): MemphisConfig {
  return {
    version: '4.0.0',
    providers: [
      { name: 'ollama', type: 'ollama', priority: 1, model: 'qwen2.5-coder:3b' },
      { name: 'minimax', type: 'minimax', priority: 2 },
    ],
    embeddings: {
      backend: 'ollama',
      model: 'nomic-embed-text',
    },
    gateway: {
      enabled: false,
      port: 18789,
      host: '127.0.0.1',
    },
    agent: {
      allowExec: true,
      allowFileWrite: true,
      blockedPaths: ['/etc', '/boot', '/sys', '/proc'],
    },
    memory: {
      path: CHAINS_PATH,
      maxInlineBytes: 65536,
      autoEmbed: true,
    },
  };
}

export function loadConfig(): MemphisConfig {
  if (!fs.existsSync(CONFIG_PATH)) return defaultConfig();
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = YAML.parse(raw);
    return { ...defaultConfig(), ...parsed };
  } catch {
    return defaultConfig();
  }
}

export function saveConfig(config: MemphisConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, YAML.stringify(config), 'utf-8');
}

export function ensureDirectories(): void {
  ensureDir(MEMPHIS_HOME);
  ensureDir(CHAINS_PATH);
}
