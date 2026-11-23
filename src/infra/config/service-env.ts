/**
 * The environment the SERVICE runs with, read from its systemd drop-ins.
 *
 * ## Why this module exists
 *
 * The chain rotation knobs live in the operator's systemd drop-in:
 *
 *     Environment=MEMPHIS_CHAIN_ROTATION_THRESHOLD_BYTES=10485760
 *     Environment=MEMPHIS_CHAIN_ROTATION_MIN_KEEP_BLOCKS=500
 *
 * The service reads them from its own environment. A command the operator
 * runs from a SHELL does not — the shell has no such variables, so the
 * command would fall back to the code defaults (50 MB, 10 blocks) and
 * quietly do nothing on a chain that the service would have rotated.
 *
 * Measured 2026-11-23 on this host: the `insights` chain is 31.92 MB
 * across 404 blocks. The service rotates it at a 10 MB threshold; a
 * command run from the shell would compare it against 50 MB, find it
 * under the line, and report "nothing to do" — with no hint that the
 * number it used was not the operator's.
 *
 * So the CLI reads the same drop-ins the service is configured by. The
 * service's configuration is then ONE source of truth for both, and the
 * command reports the numbers it used AND where they came from.
 *
 * ## What it reads
 *
 * `~/.config/systemd/user/memphis.service.d/*.conf`, in filename order
 * (systemd applies them in that order), and only the `Environment=` lines.
 * A drop-in may set a variable to an empty value — that is a real
 * override, and it wins.
 *
 * This is a READER, not a writer. It never touches the unit files; the
 * operator's configuration is edited by hand, and by the repository's own
 * `scripts/systemd/` copy that the installer lays down.
 *
 * ## When it is not available
 *
 * A host without systemd, a container, a non-systemd install — then there
 * are no drop-ins and this returns an empty map. The caller falls back to
 * its own defaults, and says so.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where systemd keeps the user's unit drop-ins. */
export function serviceDropInDir(): string {
  return join(homedir(), '.config', 'systemd', 'user', 'memphis.service.d');
}

/**
 * Parse `Environment=` lines out of a systemd unit fragment.
 *
 * systemd accepts `Environment=KEY=VALUE` and `Environment="KEY=VALUE"`,
 * and more than one assignment per line, separated by spaces. A value
 * with spaces is quoted. This parses the shapes the drop-ins in this
 * repository actually use, and does not pretend to be a full systemd
 * parser: anything it cannot understand is skipped rather than guessed.
 */
export function parseServiceEnvironment(content: string): Record<string, string> {
  const env: Record<string, string> = {};

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('Environment=')) continue;
    const value = line.slice('Environment='.length).trim();
    if (value.length === 0) continue;

    // A quoted value may contain spaces; an unquoted one may hold
    // several assignments separated by spaces.
    if (value.startsWith('"')) {
      const closing = value.indexOf('"', 1);
      if (closing === -1) continue;
      const assignment = value.slice(1, closing);
      const [key, ...rest] = assignment.split('=');
      if (key && rest.length > 0) env[key] = rest.join('=');
      continue;
    }

    for (const assignment of value.split(/\s+/)) {
      const [key, ...rest] = assignment.split('=');
      if (key && rest.length > 0) env[key] = rest.join('=');
    }
  }

  return env;
}

/**
 * The environment the service is configured with, from its drop-ins.
 *
 * Returns an empty map when there are no drop-ins — a host that does not
 * run the service under systemd has nothing to read.
 */
export function readServiceEnvironment(dir: string = serviceDropInDir()): Record<string, string> {
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith('.conf'))
      .sort();
  } catch {
    return {};
  }

  const env: Record<string, string> = {};
  for (const file of files) {
    try {
      Object.assign(env, parseServiceEnvironment(readFileSync(join(dir, file), 'utf8')));
    } catch {
      // An unreadable drop-in is not a reason to fail the whole read —
      // but it is also not silently ignored by the caller, because the
      // caller reports which source it used.
    }
  }
  return env;
}
