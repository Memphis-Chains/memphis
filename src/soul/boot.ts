import { loadIskra } from './manifest.js';
import { isSoulMemoryEmpty, loadSoulMemory } from './memory.js';
import type { SoulManifest, SoulMemory } from './types.js';

export function isSoulBootNeeded(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  const memory = loadSoulMemory(rawEnv);
  return memory === null || isSoulMemoryEmpty(memory);
}

export function buildSoulManifestFragment(manifest: SoulManifest): string {
  const compact = {
    agent: manifest.identity.agentName,
    owner: manifest.identity.ownerName,
    mode: manifest.identity.runtimeMode,
    created: manifest.identity.createdAt,
    tools: manifest.capabilities.tools,
    chains: manifest.capabilities.chains,
    channels: manifest.capabilities.channels,
    rustBridge: manifest.capabilities.rustBridge,
    boundaries: manifest.boundaries,
  };
  return `<soul_manifest>\n${JSON.stringify(compact, null, 2)}\n</soul_manifest>`;
}

export function buildSoulMemoryFragment(memory: SoulMemory): string {
  const compact = {
    user: memory.user,
    self: memory.self,
    context: memory.context,
    lastUpdated: memory.lastUpdated,
  };
  return `<soul_memory>\n${JSON.stringify(compact, null, 2)}\n</soul_memory>`;
}

export function buildSoulBootPrompt(manifest: SoulManifest): string {
  const name = manifest.identity.agentName;
  return `<soul_boot>
This is ${name}'s first conversation. Soul memory is empty.
To personalize future interactions, ask the user for:
- Their name
- Preferred languages
- Communication style preferences (concise vs detailed, formal vs casual)
- Areas of expertise or interest

Store responses using memphis_soul_write. Keep it conversational — do not present a form.
Once preferences are saved, this boot prompt will not appear again.
</soul_boot>`;
}

export function buildIskraFragment(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const iskraContent = loadIskra(rawEnv);
  if (!iskraContent) return '';
  return `<iskra>\n${iskraContent}\n</iskra>`;
}
