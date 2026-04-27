import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { resolveInstallRoot } from './install-root.js';
import { parseBool } from '../../core/env.js';

function parseIntSafe(raw: string | undefined): number | null {
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

export interface TrustRootStartupStatus {
  enabled: boolean;
  valid: boolean;
  path: string | null;
  reason?: string;
  checkedAt: string;
}

export interface RevocationCacheStartupStatus {
  enabled: boolean;
  stale: boolean;
  maxStaleMs: number;
  lastSyncMs: number | null;
  ageMs: number | null;
  reason?: string;
  checkedAt: string;
}

export function evaluateTrustRootStartup(
  rawEnv: NodeJS.ProcessEnv = process.env,
): TrustRootStartupStatus {
  const enabled = parseBool(rawEnv.MEMPHIS_TRUST_ROOT_REQUIRED, false);
  if (!enabled) {
    return {
      enabled: false,
      valid: true,
      path: null,
      reason: 'trust-root enforcement disabled',
      checkedAt: new Date().toISOString(),
    };
  }

  // Trust root is a security-critical asset; the default must anchor on the
  // install root rather than `process.cwd()` so `memphis` invoked from any
  // directory still finds the same trust manifest. Same fix family as #306.
  const explicit = rawEnv.MEMPHIS_TRUST_ROOT_PATH?.trim();
  let path: string;
  if (explicit) {
    path = resolve(explicit);
  } else {
    try {
      path = join(resolveInstallRoot({ rawEnv }), 'config', 'trust_root.json');
    } catch {
      path = resolve('./config/trust_root.json');
    }
  }
  if (!existsSync(path)) {
    return {
      enabled: true,
      valid: false,
      path,
      reason: `trust root manifest missing at ${path}`,
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      version?: unknown;
      rootIds?: unknown;
    };
    const versionValid = Number.isInteger(parsed.version) && Number(parsed.version) > 0;
    const roots = Array.isArray(parsed.rootIds)
      ? parsed.rootIds.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0,
        )
      : [];
    const rootsValid = roots.length > 0 && unique(roots);
    if (!versionValid || !rootsValid) {
      return {
        enabled: true,
        valid: false,
        path,
        reason: 'trust root manifest schema invalid (version/rootIds)',
        checkedAt: new Date().toISOString(),
      };
    }

    return {
      enabled: true,
      valid: true,
      path,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      enabled: true,
      valid: false,
      path,
      reason: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    };
  }
}

export interface TrustRootDowngradeStatus {
  allowed: boolean;
  currentVersion: number | null;
  incomingVersion: number | null;
  reason?: string;
  checkedAt: string;
}

/**
 * Rejects trust-root manifest downgrades: incoming version must be >= current version.
 * Returns { allowed: false } if the new manifest has a lower version number.
 */
export function evaluateTrustRootDowngrade(
  currentPath: string | null,
  incomingManifest: { version?: unknown },
  nowMs = Date.now(),
): TrustRootDowngradeStatus {
  const checkedAt = new Date(nowMs).toISOString();
  const incomingVersion =
    typeof incomingManifest.version === 'number' && Number.isInteger(incomingManifest.version)
      ? incomingManifest.version
      : null;

  if (incomingVersion === null) {
    return {
      allowed: false,
      currentVersion: null,
      incomingVersion: null,
      reason: 'incoming manifest has no valid integer version',
      checkedAt,
    };
  }

  if (!currentPath || !existsSync(currentPath)) {
    // No existing trust root — any valid version is accepted
    return { allowed: true, currentVersion: null, incomingVersion, checkedAt };
  }

  let currentVersion: number | null = null;
  try {
    const parsed = JSON.parse(readFileSync(currentPath, 'utf8')) as { version?: unknown };
    if (typeof parsed.version === 'number' && Number.isInteger(parsed.version)) {
      currentVersion = parsed.version;
    }
  } catch {
    // Malformed current manifest — accept incoming as replacement
    return {
      allowed: true,
      currentVersion: null,
      incomingVersion,
      reason: 'current manifest unreadable, accepting incoming',
      checkedAt,
    };
  }

  if (currentVersion === null) {
    return { allowed: true, currentVersion: null, incomingVersion, checkedAt };
  }

  if (incomingVersion < currentVersion) {
    return {
      allowed: false,
      currentVersion,
      incomingVersion,
      reason: `downgrade rejected: incoming v${incomingVersion} < current v${currentVersion}`,
      checkedAt,
    };
  }

  return { allowed: true, currentVersion, incomingVersion, checkedAt };
}

export function evaluateRevocationCacheStartup(
  rawEnv: NodeJS.ProcessEnv = process.env,
  nowMs = Date.now(),
): RevocationCacheStartupStatus {
  const enabled = parseBool(rawEnv.MEMPHIS_REVOCATION_CACHE_REQUIRED, false);
  const maxStaleMs = Math.max(
    1,
    parseIntSafe(rawEnv.MEMPHIS_REVOCATION_CACHE_MAX_STALE_MS) ?? 30_000,
  );
  if (!enabled) {
    return {
      enabled: false,
      stale: false,
      maxStaleMs,
      lastSyncMs: null,
      ageMs: null,
      reason: 'revocation cache enforcement disabled',
      checkedAt: new Date(nowMs).toISOString(),
    };
  }

  const lastSyncMs = parseIntSafe(rawEnv.MEMPHIS_REVOCATION_CACHE_LAST_SYNC_MS);
  if (lastSyncMs === null) {
    return {
      enabled: true,
      stale: true,
      maxStaleMs,
      lastSyncMs: null,
      ageMs: null,
      reason: 'missing MEMPHIS_REVOCATION_CACHE_LAST_SYNC_MS',
      checkedAt: new Date(nowMs).toISOString(),
    };
  }

  const ageMs = Math.max(0, nowMs - lastSyncMs);
  if (ageMs > maxStaleMs) {
    return {
      enabled: true,
      stale: true,
      maxStaleMs,
      lastSyncMs,
      ageMs,
      reason: `revocation cache stale: age ${ageMs}ms exceeds ${maxStaleMs}ms`,
      checkedAt: new Date(nowMs).toISOString(),
    };
  }

  return {
    enabled: true,
    stale: false,
    maxStaleMs,
    lastSyncMs,
    ageMs,
    checkedAt: new Date(nowMs).toISOString(),
  };
}
