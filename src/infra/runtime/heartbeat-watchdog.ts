/* eslint-disable no-restricted-syntax */
//
// Config-source / threading file — reads process.env directly for
// dynamic-key operations or to pass rawEnv into typed helpers that
// themselves use env-registry. Per Sprint ι policy, file-level
// disable instead of accessor-bloat.
//
/**
 * Heartbeat watchdog: periodic health monitor that checks system components
 * and logs degradation events.
 *
 * Runs on a configurable interval (default 60s). Tracks transitions between
 * healthy/degraded/unhealthy states and writes chain audit entries on state changes.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MEMPHIS_AGENT_NAME } from '../../config/env-registry.js';
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
    const threshold =
      parseFloat(process.env.MEMPHIS_MEMORY_WARN_SHARE ?? '') || DEFAULT_MEMORY_WARN_SHARE;
    checks.push(evaluateMemoryCheck(mem, { threshold }));
  } catch {
    checks.push({ name: 'memory', status: 'ok' });
  }

  return checks;
}

/**
 * Pure memory-check evaluator. Exported so unit tests can drive it
 * with synthetic `memoryUsage()` snapshots without touching the real
 * process heap.
 *
 * WHAT IT MEASURES, AND WHY IT CHANGED
 * ------------------------------------
 * It used to warn when `heapUsed / heapTotal` crossed 90 %, with a
 * 128 MB floor on the heap to filter out a young process. Measured on
 * the operator's machine (2026-11-01), that check flapped the health
 * state once an hour: the runtime watch does a burst of work, the V8
 * heap grows to ~343 MB, the ratio sits at ~90 %, the state goes
 * `degraded`, and a minute later the GC has run and it is `healthy`
 * again. 103 degraded / 102 healthy transitions in the system chain --
 * half of them noise.
 *
 * The ratio is GC pressure, not resource pressure. V8 grows the heap
 * lazily and does not shrink it eagerly, so a long-running process
 * parks at a high occupancy forever while being perfectly healthy: the
 * memphis service was using 310 MB of a 343 MB heap on a machine with
 * 10 GB free, and there is no cgroup limit on the unit
 * (`MemoryMax=infinity`).
 *
 * The failure this check exists to catch is the process starving the
 * machine and being OOM-killed. So it measures the process's RSS
 * against the HOST's memory, which is the OOM killer's own view. On
 * this machine the service sits at 629 MB of 15 423 MB -- 4 % -- which
 * is what "healthy" looks like.
 *
 * The heap occupancy stays in the message: it is worth knowing, it just
 * does not decide the state.
 */
export const DEFAULT_MEMORY_WARN_SHARE = 0.25;

export interface MemorySnapshot {
  heapUsed: number;
  heapTotal: number;
  /** The process's resident set size — the OOM killer's view of it. */
  rss: number;
}

export function evaluateMemoryCheck(
  mem: MemorySnapshot,
  options: { threshold?: number; hostTotalBytes?: number } = {},
): WatchdogCheck {
  const threshold = options.threshold ?? DEFAULT_MEMORY_WARN_SHARE;
  const hostTotal = options.hostTotalBytes ?? os.totalmem();
  const rssMb = Math.round(mem.rss / (1024 * 1024));
  const hostMb = Math.round(hostTotal / (1024 * 1024));
  const share = hostTotal > 0 ? mem.rss / hostTotal : 0;
  const heapRatio = mem.heapTotal > 0 ? mem.heapUsed / mem.heapTotal : 0;
  return {
    name: 'memory',
    status: share > threshold ? 'warn' : 'ok',
    message: `RSS ${rssMb}/${hostMb} MB (${Math.round(share * 100)}% of host, heap ${Math.round(heapRatio * 100)}%)`,
  };
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
  const agentName = MEMPHIS_AGENT_NAME.read(process.env);

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
      const base = line.match(
        /^- (\S+) (BOOT|HEARTBEAT|IDENTITY-ASSERT|ADAPTATION|MODE-CHANGE) health=(\S+) uptime=(\d+)s(.*)$/,
      );
      if (!base) continue;

      const entry: PulseEntry = {
        timestamp: base[1]!,
        event: base[2]!.toLowerCase().replace(/-/g, '-') as PulseEventType,
        health: base[3] as PulseEntry['health'],
        uptimeSeconds: parseInt(base[4]!, 10),
      };

      // Extract structured tail fields (mode=…, surfaces=…) and treat
      // whatever is left as free-form `detail`. Writer order is fixed
      // (mode first, then surfaces, then detail), so parse
      // positionally rather than regex-matching the whole tail — a
      // detail string containing literal "mode=…" or "surfaces=…"
      // (e.g., an error message like "mode=readonly refused") would
      // otherwise get pulled into cognitiveMode / activeSurfaces and
      // vanish from detail. (Codex follow-up on #217.)
      let tail = (base[5] ?? '').replace(/^\s+/, '');

      if (tail.startsWith('mode=')) {
        const match = tail.match(/^mode=(\S+)\s*/);
        if (match) {
          entry.cognitiveMode = match[1]!;
          tail = tail.slice(match[0].length);
        }
      }

      if (tail.startsWith('surfaces=')) {
        const match = tail.match(/^surfaces=(\S+)\s*/);
        if (match) {
          entry.activeSurfaces = match[1]!.split(',').filter(Boolean);
          tail = tail.slice(match[0].length);
        }
      }

      const detail = tail.replace(/\s+/g, ' ').trim();
      if (detail.length > 0) {
        entry.detail = detail;
      }

      entries.push(entry);
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

/**
 * Turn the `WatchdogCheck[]` array into a single-line detail string that
 * names the failing checks. Example output:
 *
 *     warn:embed_bridge:bridge unavailable warn:memory:475/524 MB (91%)
 *
 * Returns `undefined` when every check is ok, so the PULSE line stays
 * clean on healthy heartbeats.
 */
export function buildHeartbeatDetail(checks: WatchdogCheck[]): string | undefined {
  const problems = checks
    .filter((check) => check.status !== 'ok')
    .map((check) => {
      const hint = check.message ? `:${check.message}` : '';
      return `${check.status}:${check.name}${hint}`;
    });
  return problems.length > 0 ? problems.join(' ') : undefined;
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
    detail: buildHeartbeatDetail(heartbeat.checks),
  });
}
