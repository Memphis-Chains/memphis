/**
 * Vault filesystem path resolution — single source of truth.
 *
 * Before this module, `vault-state.json` and `vault-entries.json` defaulted
 * to relative `./data/...` paths inside both `rust-vault-adapter.ts` (state)
 * and `vault-entry-store.ts` (entries). The relative defaults meant every
 * process whose cwd happened to be the repo root shared the same vault
 * paths as the production daemon — including smoke tests, agent self-tests,
 * and one-shot `node scripts/...` invocations. The 2026-04-25 silent re-init
 * incident traced back to exactly this footgun.
 *
 * This helper centralizes the path policy:
 *
 * 1. Explicit env override (MEMPHIS_VAULT_STATE_PATH / MEMPHIS_VAULT_ENTRIES_PATH)
 *    wins. Smoke scripts must always set these to a tmpdir.
 *
 * 2. If a LEGACY relative file exists at `${installRoot}/data/<filename>`,
 *    use it (backward-compat for operators who initialized vault before this
 *    change) and emit a one-time deprecation warning so it surfaces in the
 *    logs without spamming.
 *
 * 3. Otherwise default to `${MEMPHIS_HOME ?? ~/.memphis}/<filename>` —
 *    absolute path independent of cwd.
 *
 * The legacy detection uses `resolveInstallRoot` from `infra/runtime/install-root.ts`
 * which walks up from cwd and falls back to the binary path; that's the
 * same logic the dotenv loader uses, so this helper agrees with `.env`
 * resolution. If install root can't be discovered (rare; shouldn't happen
 * for a cli-launched memphis), we skip the legacy step and use the new default.
 */

import { existsSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';

import {
  bridgeResolveVaultEntries,
  bridgeResolveVaultState,
} from './rust-paths-bridge.js';
import { getDataDir } from '../../config/paths.js';
import { resolveInstallRoot } from '../runtime/install-root.js';

export type VaultFile = 'vault-state.json' | 'vault-entries.json';

const ENV_KEYS: Record<VaultFile, string> = {
  'vault-state.json': 'MEMPHIS_VAULT_STATE_PATH',
  'vault-entries.json': 'MEMPHIS_VAULT_ENTRIES_PATH',
};

const warnedLegacy = new Set<VaultFile>();

function ensureHome(rawEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (rawEnv.HOME && rawEnv.HOME.trim().length > 0) return rawEnv;
  return { ...rawEnv, HOME: os.homedir() };
}

function bridgeDefaultFor(file: VaultFile, rawEnv: NodeJS.ProcessEnv): string {
  // Bridge gives us the canonical default `<data_dir>/<file>` path. If it
  // fails (rare; pre-build), fall back to the legacy TS path composition.
  try {
    return file === 'vault-state.json'
      ? bridgeResolveVaultState(ensureHome(rawEnv))
      : bridgeResolveVaultEntries(ensureHome(rawEnv));
  } catch {
    return join(getDataDir(rawEnv), file);
  }
}

export function resolveVaultPath(file: VaultFile, rawEnv: NodeJS.ProcessEnv): string {
  const envKey = ENV_KEYS[file];
  const explicit = rawEnv[envKey]?.trim();
  if (explicit) {
    // Absolute path → verbatim. Relative override (legacy .env files
    // shipped with `MEMPHIS_VAULT_ENTRIES_PATH=./data/vault-entries.json`)
    // resolves against installRoot, NOT cwd. The bridge resolves against
    // process.cwd() per its contract, so we keep the install-root anchor
    // here in TS — operator-friendly behavior preserved across migration.
    if (explicit.startsWith('/') || /^[A-Za-z]:[\\/]/.test(explicit)) {
      return resolve(explicit);
    }
    try {
      return resolve(resolveInstallRoot({ rawEnv }), explicit);
    } catch {
      return resolve(explicit);
    }
  }

  // Backward-compat: a vault that was initialized before the absolute-path
  // migration lives at `${installRoot}/data/<file>`. If we see it there,
  // keep using it but surface a one-time hint so the operator can migrate
  // at their leisure. This existence check stays in TS — it is a
  // filesystem-aware fallback the pure Rust resolver intentionally does
  // not perform (memphis-paths has no I/O by design).
  let installRoot: string | null = null;
  try {
    installRoot = resolveInstallRoot({ rawEnv });
  } catch {
    // No install root discoverable — happens when the script is launched
    // far outside the repo. Fall through to the new absolute default.
  }
  if (installRoot) {
    const legacyPath = join(installRoot, 'data', file);
    if (existsSync(legacyPath)) {
      if (!warnedLegacy.has(file)) {
        warnedLegacy.add(file);
        process.stderr.write(
          `[memphis-vault] WARNING: using legacy ${file} at ${legacyPath}. ` +
            `New default is ${bridgeDefaultFor(file, rawEnv)}. ` +
            `Migrate by moving the file or setting ${envKey}=<absolute-path>.\n`,
        );
      }
      return legacyPath;
    }
  }

  // New default: absolute path under MEMPHIS_HOME (~/.memphis by default).
  // Independent of cwd, so smoke tests / one-shot scripts cannot collide
  // with the production daemon by accident. Sourced from the Rust
  // memphis-paths crate so this layer agrees with memphis-operator's
  // load_vault path resolution down to the byte.
  return bridgeDefaultFor(file, rawEnv);
}

/**
 * Test-only: clear the one-time deprecation cache so each test sees a fresh
 * warning lifecycle.
 */
export function __resetVaultPathWarnings(): void {
  warnedLegacy.clear();
}
