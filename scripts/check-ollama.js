#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

function hasCommand(command) {
  const cmd = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  const result = spawnSync(cmd, args, { shell: process.platform !== 'win32', stdio: 'ignore' });
  return result.status === 0;
}

const hasOllamaCli = hasCommand('ollama');
const usingOllama =
  process.env.DEFAULT_PROVIDER === 'ollama' ||
  process.env.RUST_EMBED_MODE === 'ollama' ||
  (!process.env.DEFAULT_PROVIDER && !process.env.RUST_EMBED_MODE);

if (!hasOllamaCli && usingOllama) {
  console.warn('[memphis-install] Ollama CLI not found.');
  console.warn('[memphis-install] Memphis will still install, but Ollama-backed features will be unavailable until installed.');
  console.warn('[memphis-install] Install Ollama: https://ollama.com/download');
  console.warn('[memphis-install] Then pull model: ollama pull nomic-embed-text');
}
