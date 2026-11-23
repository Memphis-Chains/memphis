/**
 * Skill facts — the facts a skill directory holds, measured.
 *
 * ## Why this module exists
 *
 * A skill lives in TWO places on this host:
 *
 *   - the repository (`skills/<id>/`) — the source of truth, the place
 *     the code is edited and the place the HALT hook reads from;
 *   - the runtime (`~/.memphis/skills/{catalog,installed}/<id>/`) — the
 *     materialization the MCP server and the CLI read.
 *
 * The two are copies, and copies drift. Measured on this host before the
 * gate existed: the runtime copy of `usb-grabber-feed` still described
 * `memphis_cron` for the daily audit while the repository copy already
 * described `memphis_cron_script` — two different truths for one skill,
 * and the runtime one was the older.
 *
 * So the copy is not the problem; the copy WITHOUT A COMPARISON is. This
 * module produces the two digests that comparison needs:
 *
 *   - `skillMdDigest` — sha256 of the SKILL.md bytes. The document is
 *     copied verbatim, so bytes are the right unit here.
 *   - `manifestDigest` — a canonical digest of the PARSED manifest. The
 *     installer rewrites the manifest through `normalizeSkillManifest`,
 *     which sorts the tags and the tools; comparing bytes would report
 *     a difference where there is none, so the manifest is compared by
 *     what it says, not by how it is formatted.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type SkillFact = {
  /** The skill id — the directory name. */
  readonly id: string;
  /** sha256 of SKILL.md, or null when the file is absent. */
  readonly skillMdDigest: string | null;
  /** Canonical digest of manifest.json, or null when it is absent or unparseable. */
  readonly manifestDigest: string | null;
  /** True when the manifest exists but could not be parsed. */
  readonly manifestUnreadable: boolean;
};

/**
 * A canonical rendering of a JSON value: keys sorted, recursively.
 *
 * `JSON.stringify(value, keys)` is NOT a key sorter — the second argument
 * is a whitelist of property names to EMIT, at every level. Using it as
 * one silently drops properties from the comparison. Sorting the keys of
 * the object is the only way to compare two renderings.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Measure one skill directory.
 *
 * A missing file is a fact too: `null` means "this file is not there",
 * which is different from "this file is there and differs".
 */
export async function readSkillFact(skillDir: string, id: string): Promise<SkillFact> {
  const skillMd = await readFile(join(skillDir, 'SKILL.md'), 'utf8').catch(() => null);
  const manifestText = await readFile(join(skillDir, 'manifest.json'), 'utf8').catch(() => null);

  let manifestDigest: string | null = null;
  let manifestUnreadable = false;
  if (manifestText !== null) {
    try {
      manifestDigest = digestOf(canonicalJson(JSON.parse(manifestText)));
    } catch {
      manifestUnreadable = true;
    }
  }

  return {
    id,
    skillMdDigest: skillMd === null ? null : digestOf(skillMd),
    manifestDigest,
    manifestUnreadable,
  };
}
