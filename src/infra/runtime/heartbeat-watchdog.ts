/**
 * Heartbeat watchdog: periodic health monitor that checks system components
 * and logs degradation events.
 *
 * Runs on a configurable interval (default 60s). Tracks transitions between
 * healthy/degraded/unhealthy states and writes chain audit entries on state changes.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { getConfigPath } from '../../config/paths.js';
import { getActiveSurfacesSnapshot } from '../../core/surface-presence.js';
import type { PulseEntry, PulseEventType } from '../../soul/types.js';
import { getChainAdapterStatus } from '../storage/chain-adapter.js';
import { getRustEmbedAdapterStatus } from '../storage/rust-embed-adapter.js';
import { getRustVaultAdapterStatus } from '../storage/rust-vault-adapter.js';

export type WatchdogHealth = 'healthy' | 'degraded' | 'unhealthy';

export interface WatchdogCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message?: string;
}

export interface WatchdogHeartbeat {
  timestamp: string;
  health: WatchdogHealth;
  checks: WatchdogCheck[];
  uptimeSeconds: number;
}

export interface WatchdogOptions {
  /** Interval between heartbeats in milliseconds. Default: 60_000 (1 minute). */
  intervalMs?: number;
  /** Callback invoked on each heartbeat. */
  onHeartbeat?: (heartbeat: WatchdogHeartbeat) => void;
  /** Callback invoked when health state changes. */
  onStateChange?: (from: WatchdogHealth, to: WatchdogHealth, heartbeat: WatchdogHeartbeat) => void;
}

const DEFAULT_INTERVAL_MS = 60_000;

export class HeartbeatWatchdog {
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentHealth: WatchdogHealth = 'healthy';
  private tickCount = 0;
  private readonly intervalMs: number;
  private readonly onHeartbeat?: (heartbeat: WatchdogHeartbeat) => void;
  private readonly onStateChange?: (
    from: WatchdogHealth,
    to: WatchdogHealth,
    heartbeat: WatchdogHeartbeat,
  ) => void;

  constructor(options: WatchdogOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.onHeartbeat = options.onHeartbeat;
    this.onStateChange = options.onStateChange;
  }

  /** Start the watchdog timer. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    // Unref so the watchdog doesn't prevent process exit
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  /** Stop the watchdog timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Get the current health state. */
  get health(): WatchdogHealth {
    return this.currentHealth;
  }

  /** Run a single heartbeat check. */
  async tick(): Promise<WatchdogHeartbeat> {
    this.tickCount++;
    const checks = runHealthChecks();
    const health = deriveHealth(checks);

    const heartbeat: WatchdogHeartbeat = {
      timestamp: new Date().toISOString(),
      health,
      checks,
      uptimeSeconds: Math.floor(process.uptime()),
    };

    const stateChanged = health !== this.currentHealth;
    if (stateChanged) {
      const previous = this.currentHealth;
      this.currentHealth = health;
      this.onStateChange?.(previous, health, heartbeat);
    }

    this.onHeartbeat?.(heartbeat);

    // Write PULSE on state changes or every 10 ticks (~10 minutes at default interval)
    if (stateChanged || this.tickCount % 10 === 0) {
      try {
        writeHeartbeatPulse(heartbeat);
      } catch {
        // PULSE write is non-fatal
      }
    }

    return heartbeat;
  }
}

function runHealthChecks(): WatchdogCheck[] {
  const checks: WatchdogCheck[] = [];

  // Chain adapter
  try {
    const chainStatus = getChainAdapterStatus();
    checks.push({
      name: 'chain_adapter',
      status: chainStatus.rustBridgeLoaded || chainStatus.backend === 'ts-legacy' ? 'ok' : 'warn',
      message: `backend=${chainStatus.backend}`,
    });
  } catch (err) {
    checks.push({
      name: 'chain_adapter',
      status: 'fail',
      message: err instanceof Error ? err.message : 'check failed',
    });
  }

  // Vault bridge
  try {
    const vaultStatus = getRustVaultAdapterStatus();
    if (!vaultStatus.rustEnabled) {
      checks.push({ name: 'vault_bridge', status: 'ok', message: 'rust disabled' });
    } else if (vaultStatus.bridgeLoaded && vaultStatus.vaultApiAvailable) {
      checks.push({ name: 'vault_bridge', status: 'ok' });
    } else {
      checks.push({ name: 'vault_bridge', status: 'fail', message: 'bridge unavailable' });
    }
  } catch (err) {
    checks.push({
      name: 'vault_bridge',
      status: 'fail',
      message: err instanceof Error ? err.message : 'check failed',
    });
  }

  // Embed bridge
  try {
    const embedStatus = getRustEmbedAdapterStatus();
    if (!embedStatus.rustEnabled) {
      checks.push({ name: 'embed_bridge', status: 'ok', message: 'rust disabled' });
    } else if (embedStatus.bridgeLoaded && embedStatus.embedApiAvailable) {
      checks.push({ name: 'embed_bridge', status: 'ok' });
    } else {
      checks.push({ name: 'embed_bridge', status: 'warn', message: 'bridge unavailable' });
    }
  } catch (err) {
    checks.push({
      name: 'embed_bridge',
      status: 'fail',
      message: err instanceof Error ? err.message : 'check failed',
    });
  }

  // Process memory
  try {
    const mem = process.memoryUsage();
    const heapUsedMb = Math.round(mem.heapUsed / (1024 * 1024));
    const heapTotalMb = Math.round(mem.heapTotal / (1024 * 1024));
    const ratio = mem.heapUsed / mem.heapTotal;
    const threshold = parseFloat(process.env.MEMPHIS_MEMORY_WARN_THRESHOLD ?? '0.9') || 0.9;
    checks.push({
      name: 'memory',
      status: ratio > threshold ? 'warn' : 'ok',
      message: `${heapUsedMb}/${heapTotalMb} MB (${Math.round(ratio * 100)}%)`,
    });
  } catch {
    checks.push({ name: 'memory', status: 'ok' });
  }

  return checks;
}

function deriveHealth(checks: WatchdogCheck[]): WatchdogHealth {
  const hasFail = checks.some((c) => c.status === 'fail');
  const hasWarn = checks.some((c) => c.status === 'warn');

  if (hasFail) return 'unhealthy';
  if (hasWarn) return 'degraded';
  return 'healthy';
}

// ── PULSE.md ──────────────────────────────────────────────────────────────────

const PULSE_MAX_ENTRIES = 50;

export function getPulsePath(): string {
  return getConfigPath('PULSE.md');
}

export function writePulseEvent(entry: PulseEntry): void {
  const pulsePath = getPulsePath();
  const dir = path.dirname(pulsePath);
  mkdirSync(dir, { recursive: true });

  const existing = loadPulseEntries();
  existing.push(entry);

  // Keep only the most recent entries
  const trimmed = existing.slice(-PULSE_MAX_ENTRIES);
  const agentName = process.env.MEMPHIS_AGENT_NAME ?? 'Memphis Agent';

  const header = [
    `# PULSE — ${agentName}`,
    `Last: ${entry.timestamp} | Status: ${entry.health} | Uptime: ${entry.uptimeSeconds}s${entry.cognitiveMode ? ` | Mode: ${entry.cognitiveMode}` : ''}`,
    '',
    '## Recent',
  ].join('\n');

  const lines = trimmed.map((e) => {
    const parts = [`- ${e.timestamp} ${e.event.toUpperCase()}`];
    parts.push(`health=${e.health}`);
    parts.push(`uptime=${e.uptimeSeconds}s`);
    if (e.cognitiveMode) parts.push(`mode=${e.cognitiveMode}`);
    if (e.activeSurfaces && e.activeSurfaces.length > 0) {
      parts.push(`surfaces=${e.activeSurfaces.join(',')}`);
    }
    if (e.detail) parts.push(e.detail);
    return parts.join(' ');
  });

  const content = `${header}\n${lines.join('\n')}\n`;

  const tmpPath = `${pulsePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, pulsePath);
}

export function loadPulseEntries(): PulseEntry[] {
  const pulsePath = getPulsePath();
  if (!existsSync(pulsePath)) return [];

  try {
    const raw = readFileSync(pulsePath, 'utf8');
    const entries: PulseEntry[] = [];
    const lines = raw.split('\n');

    for (const line of lines) {
      const match = line.match(
        /^- (\S+) (BOOT|HEARTBEAT|IDENTITY-ASSERT|ADAPTATION|MODE-CHANGE) health=(\S+) uptime=(\d+)s/,
      );
      if (match) {
        const entry: PulseEntry = {
          timestamp: match[1]!,
          event: match[2]!.toLowerCase().replace(/-/g, '-') as PulseEventType,
          health: match[3] as PulseEntry['health'],
          uptimeSeconds: parseInt(match[4]!, 10),
        };
        const surfaces = line.match(/surfaces=(\S+)/);
        if (surfaces) {
          entry.activeSurfaces = surfaces[1]!.split(',').filter(Boolean);
        }
        entries.push(entry);
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export function writeBootPulse(): void {
  writePulseEvent({
    timestamp: new Date().toISOString(),
    event: 'boot',
    health: 'healthy',
    uptimeSeconds: 0,
    detail: `provider=${process.env.DEFAULT_PROVIDER ?? 'unknown'}`,
  });
}

function writeHeartbeatPulse(heartbeat: WatchdogHeartbeat): void {
  const surfaces = getActiveSurfacesSnapshot()
    .filter((snapshot) => !snapshot.stale)
    .map((snapshot) => snapshot.surface);
  writePulseEvent({
    timestamp: heartbeat.timestamp,
    event: 'heartbeat',
    health: heartbeat.health,
    uptimeSeconds: heartbeat.uptimeSeconds,
    activeSurfaces: surfaces.length > 0 ? surfaces : undefined,
  });
}
