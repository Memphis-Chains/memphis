/**
 * Tier-3 session persistence — survives daemon restart.
 *
 * Before this module: tier-3 sessions lived only in the in-memory Map
 * `const sessions = new Map<string, Tier3Session>()` inside
 * `tier3-session.ts`. Every daemon restart (graceful, crash, or
 * upgrade) wiped every active elevation, forcing the operator to
 * re-elevate after a `systemctl restart memphis` or
 * `memphis service restart`.
 *
 * After this module: grants are mirrored to disk at
 * `~/.memphis/state/tier3-sessions.json` (chmod 0600). On daemon
 * start, the file is loaded; expired entries are dropped + audited as
 * `tier3-expire`; live entries are restored to the in-memory Map.
 *
 * Persistence format: JSON array of `Tier3Session` records. No
 * passphrase, no hash, no recovery secret — just the elevation
 * metadata (surface, actorId, grantedAt, expiresAt). The grant was
 * already authorized when the entry was first written; reading it
 * back doesn't re-validate (the operator passphrase check has
 * already happened). If an attacker can write to the state file they
 * can already exec arbitrary code as the operator — this file does
 * not raise the trust bar.
 *
 * Atomic writes via tmp + rename pattern (same as `persist_best_effort`
 * in `crates/memphis-embed/src/pipeline.rs` and vault state writes).
 *
 * Feature gate: `MEMPHIS_TIER3_PERSIST=0` disables persistence
 * (sessions back to in-memory only). Default: enabled.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Tier3Session, Tier3Surface } from './tier3-session.js';

// Mirror of `TIER_3_TTL_MS` from tier3-session.ts. Inlined here to
// break the import cycle (tier3-session.ts imports this module's
// functions at top level + calls hydrateFromDisk() at module load,
// which races a `const TIER_3_TTL_MS` import from the same module
// and triggers a TDZ ReferenceError on STATE_DIR_NAME). Keep in sync
// with tier3-session.ts if the TTL ever changes — both files are
// part of the same logical change unit.
const TIER_3_TTL_MS_FOR_VALIDATION = 3 * 60 * 60 * 1000;

const FILE_NAME = 'tier3-sessions.json';
const STATE_DIR_NAME = 'state';

/**
 * Resolve the persistence file path. Uses `MEMPHIS_HOME` env if set,
 * else `~/.memphis/`. The `state/` subdirectory is shared with
 * `self-modify-revert.ts` (per `src/config/paths.ts:111` allow-list).
 */
export function getPersistencePath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  const home = rawEnv.MEMPHIS_HOME ?? path.join(rawEnv.HOME ?? '/tmp', '.memphis');
  return path.join(home, STATE_DIR_NAME, FILE_NAME);
}

function isFeatureEnabled(rawEnv: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (rawEnv.MEMPHIS_TIER3_PERSIST ?? '1').trim();
  return flag !== '0' && flag.toLowerCase() !== 'false';
}

interface PersistedSession {
  surface: Tier3Surface;
  actorId: string;
  tier: 3;
  grantedAt: number;
  expiresAt: number;
}

function validateSession(
  raw: unknown,
  now: number = Date.now(),
): PersistedSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.tier !== 3) return null;
  if (typeof obj.grantedAt !== 'number' || !Number.isFinite(obj.grantedAt)) return null;
  if (typeof obj.expiresAt !== 'number' || !Number.isFinite(obj.expiresAt)) return null;
  if (typeof obj.actorId !== 'string' || obj.actorId.length === 0) return null;
  const surface = obj.surface;
  if (surface !== 'tui' && surface !== 'telegram' && surface !== 'http' && surface !== 'cli') {
    return null;
  }
  // Replay-attack defense — a tampered state file can claim arbitrary
  // grantedAt/expiresAt values. Without these bounds an attacker who
  // writes the file (same-uid local process, restored backup from
  // another host) could plant `expiresAt: 9999999999999` for permanent
  // elevation, or `grantedAt: future` so the TTL clamp itself stretches
  // indefinitely. Both bounds are required: clamp expiresAt to
  // grantedAt+TTL AND clamp grantedAt to "not in the future".
  // Small grace (60s) on grantedAt handles minor clock skew across
  // suspend/resume; anything bigger looks like tampering.
  const GRANT_CLOCK_SKEW_MS = 60_000;
  if (obj.grantedAt > now + GRANT_CLOCK_SKEW_MS) return null;
  if (obj.expiresAt > obj.grantedAt + TIER_3_TTL_MS_FOR_VALIDATION) return null;
  return {
    surface,
    actorId: obj.actorId,
    tier: 3,
    grantedAt: obj.grantedAt,
    expiresAt: obj.expiresAt,
  };
}

/**
 * Read tier-3 sessions from disk. Expired entries are dropped silently
 * (the caller is responsible for emitting `tier3-expire` audit events
 * for any sessions it cares about — typically only the restore path
 * does, since startup-time expiry is operationally identical to "the
 * session ran its course while the daemon was down").
 *
 * Returns an empty array on any I/O error or parse failure — the
 * runtime never blocks startup on bad state-file content. The error
 * is logged so operator can investigate without losing the daemon.
 */
export function loadPersistedSessions(
  rawEnv: NodeJS.ProcessEnv = process.env,
): Tier3Session[] {
  if (!isFeatureEnabled(rawEnv)) return [];
  const filePath = getPersistencePath(rawEnv);
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      // Don't echo filePath — it would leak MEMPHIS_HOME into any
      // log forwarder. Fixed message is enough; operator can grep
      // the prefix to locate the source.
      console.warn('[tier3-persistence] state file has unexpected shape — ignoring');
      return [];
    }
    const now = Date.now();
    const out: Tier3Session[] = [];
    for (const entry of parsed) {
      const validated = validateSession(entry, now);
      if (!validated) continue;
      if (validated.expiresAt <= now) continue;
      out.push(validated as Tier3Session);
    }
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tier3-persistence] load failed: ${msg} — starting with empty Map`);
    return [];
  }
}

/**
 * Atomically persist the in-memory session map to disk.
 *
 * `sessions` is the full Map from `tier3-session.ts`. We copy values
 * to an array, serialize, write to a tmp file, then `fs.renameSync`
 * to the target path — this is atomic on the same filesystem and
 * protects against partial-write corruption on crash.
 *
 * Errors are logged but not thrown. A failed persist means the next
 * daemon restart won't see the grant, which degrades gracefully to
 * "operator must re-elevate" — the operator state is never worse
 * than today's in-memory-only baseline.
 */
export function persistSessions(
  sessions: Iterable<[string, Tier3Session]>,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  if (!isFeatureEnabled(rawEnv)) return;
  const filePath = getPersistencePath(rawEnv);
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const arr: Tier3Session[] = [];
    for (const [, session] of sessions) {
      arr.push(session);
    }
    const tmpPath = filePath + '.tmp';
    // Symlink defense — an attacker (same-uid local process) could
    // pre-create $tmpPath as a symlink targeting an arbitrary writable
    // path (e.g. ~/.config/systemd/user/), and our writeFileSync would
    // follow it and clobber the target. unlinkSync the tmp first to
    // remove any pre-planted symlink. ENOENT (no file) is the happy
    // path so swallow it; other errors propagate to the outer catch.
    try {
      fs.unlinkSync(tmpPath);
    } catch (e) {
      const errno = (e as NodeJS.ErrnoException).code;
      if (errno !== 'ENOENT') throw e;
    }
    // Atomic write — openSync with O_CREAT|O_WRONLY|O_EXCL prevents
    // TOCTOU between the unlink above and the open; fsync before
    // rename guarantees the data blocks reach disk before the rename
    // makes them visible as the canonical state file. Without fsync,
    // a crash between writeFileSync (page-cache only) and renameSync
    // could leave a corrupt canonical file with a torn write.
    const fd = fs.openSync(tmpPath, fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_EXCL, 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(arr, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tier3-persistence] save failed: ${msg} — in-memory state intact`);
  }
}

/**
 * Wipe the persistence file. Used by tests + by `vault reset` flow
 * (operator passphrase rotation invalidates all prior elevations
 * implicitly, but we also want the persisted state cleared so a
 * subsequent daemon restart doesn't try to load stale grants).
 */
export function clearPersistedSessions(rawEnv: NodeJS.ProcessEnv = process.env): void {
  const filePath = getPersistencePath(rawEnv);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[tier3-persistence] clear failed: ${msg}`);
  }
}
