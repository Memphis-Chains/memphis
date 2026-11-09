import { createHash, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';

import { validateOperatorPassphrase } from './operator-gate.js';
import { getDataDir } from '../../config/paths.js';
import type { SoulManifest } from '../../soul/types.js';

/** A missing or malformed manifest never enables the operator fallback. */
export function usesOperatorForTier2(manifest: SoulManifest | null): boolean {
  return manifest?.evolution.tier2AuthMode === 'operator';
}

export function validateTier2Passphrase(
  passphrase: string | undefined,
  manifest: SoulManifest | null,
  rawEnv: NodeJS.ProcessEnv = process.env,
): 'ok' | 'missing' | 'invalid' {
  if (!manifest) return 'missing';
  if (usesOperatorForTier2(manifest)) {
    // loadSoulManifest resolves its config path from the process environment,
    // whereas the operator gate accepts rawEnv. Never let a credential from
    // a different data directory authorize this manifest.
    try {
      if (resolve(getDataDir(rawEnv)) !== resolve(getDataDir())) return 'invalid';
    } catch {
      return 'invalid';
    }
    return passphrase && validateOperatorPassphrase(passphrase, rawEnv) ? 'ok' : 'invalid';
  }
  const expected = manifest.evolution.passphraseHash;
  if (!expected || !/^[a-f0-9]{64}$/i.test(expected)) return 'missing';
  if (!passphrase) return 'invalid';
  const actual = createHash('sha256').update(passphrase).digest();
  return timingSafeEqual(actual, Buffer.from(expected, 'hex')) ? 'ok' : 'invalid';
}
