import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentIdentity } from './model-d-types.js';

function clampReputation(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function socialDir(): string {
  return join(homedir(), '.memphis', 'social');
}

function agentsPath(): string {
  return join(socialDir(), 'agents.json');
}

export class AgentRegistry {
  private agents = new Map<string, AgentIdentity>();

  constructor(private readonly storagePath: string = agentsPath()) {
    this.load();
  }

  /**
   * Registers or replaces an agent identity in the local registry.
   */
  register(agent: AgentIdentity): void {
    const normalized: AgentIdentity = {
      ...agent,
      reputation: clampReputation(agent.reputation),
      lastSeen: new Date(agent.lastSeen),
    };
    this.agents.set(normalized.did, normalized);
    this.save();
  }

  /**
   * Returns the registered agent for the provided DID, if present.
   */
  getAgent(did: string): AgentIdentity | null {
    return this.agents.get(did) ?? null;
  }

  /**
   * Applies a reputation delta and refreshes the agent's last-seen timestamp.
   */
  updateReputation(did: string, delta: number): void {
    const agent = this.agents.get(did);
    if (!agent) return;

    agent.reputation = clampReputation(agent.reputation + delta);
    agent.lastSeen = new Date();
    this.agents.set(did, agent);
    this.save();
  }

  /**
   * Lists agents that have been seen within the provided time window.
   */
  listActive(withinMs: number): AgentIdentity[] {
    const cutoff = Date.now() - withinMs;
    return Array.from(this.agents.values()).filter((agent) => new Date(agent.lastSeen).getTime() >= cutoff);
  }

  /**
   * Returns every known agent in the registry.
   */
  listAll(): AgentIdentity[] {
    return Array.from(this.agents.values());
  }

  private load(): void {
    if (!existsSync(this.storagePath)) return;
    const raw = JSON.parse(readFileSync(this.storagePath, 'utf8')) as AgentIdentity[];
    for (const agent of raw) {
      this.agents.set(agent.did, { ...agent, lastSeen: new Date(agent.lastSeen) });
    }
  }

  private save(): void {
    mkdirSync(socialDir(), { recursive: true });
    writeFileSync(this.storagePath, JSON.stringify(this.listAll(), null, 2), 'utf8');
  }
}
