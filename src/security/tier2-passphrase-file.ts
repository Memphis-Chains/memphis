/**
 * Tier 2 Passphrase File Reader
 * 
 * Allows Memphis agent to automatically obtain the vault passphrase
 * from a protected file, enabling self-modification without interactive input.
 * 
 * File location: ~/.memphis/.tier2-passphrase
 * File permissions: 600 (owner read/write only)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { getDataDir } from '../config/paths.js';

const TIER2_PASSPHRASE_FILENAME = '.tier2-passphrase';

/**
 * Get the path to the tier2 passphrase file
 */
export function getTier2PassphrasePath(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return join(getDataDir(rawEnv), TIER2_PASSPHRASE_FILENAME);
}

/**
 * Read tier2 passphrase from file.
 * Returns null if file doesn't exist or can't be read.
 */
export function readTier2PassphraseFromFile(rawEnv: NodeJS.ProcessEnv = process.env): string | null {
  const path = getTier2PassphrasePath(rawEnv);
  
  if (!existsSync(path)) {
    return null;
  }
  
  try {
    const content = readFileSync(path, 'utf8').trim();
    if (content.length < 8) {
      console.warn(`[tier2] Warning: passphrase file too short (min 8 chars)`);
      return null;
    }
    return content;
  } catch (err) {
    console.warn(`[tier2] Warning: failed to read passphrase file: ${err}`);
    return null;
  }
}

/**
 * Write tier2 passphrase to file.
 * Creates parent directory if needed.
 */
export function writeTier2PassphraseToFile(
  passphrase: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): void {
  const path = getTier2PassphrasePath(rawEnv);
  const dir = dirname(path);
  
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  
  writeFileSync(path, passphrase, { mode: 0o600 });
}
