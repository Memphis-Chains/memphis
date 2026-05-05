/**
 * Single source of truth for runtime env-var access.
 *
 * Background (`~/.claude/plans/memphis-architectural-refactor.md` plan #3):
 * the codebase reads env vars through `process.env.FOO ?? 'default'`
 * patterns scattered across 30+ files. Each fallback chain is its own
 * decision; the same var sometimes has 3 different chains in 3
 * different files. The "operator ustawił X ale Memphis nie widzi" bug
 * class lives in this gap.
 *
 * This module is the canonical accessor layer. Each call site (logger,
 * doctor, telemetry, etc.) imports a typed accessor instead of touching
 * `process.env` directly. Adding a new env var = one entry here +
 * corresponding Zod schema entry; that pair is the contract every
 * other module reads through.
 *
 * Phase 1 (this file, PR #428): 5 high-traffic accessors as proof +
 * registry-introspection surface for `memphis doctor` so operators
 * can see at a glance which env vars Memphis actually reads, what
 * the resolved value was, and whether it came from the env or the
 * default. Phase 2 (follow-up PR) adds an ESLint rule that forbids
 * raw `process.env.X` reads in `src/` outside this module. Phase 3
 * gradually migrates the remaining 30+ call sites. Schema (Zod) and
 * registry (this module) stay aligned by hand for now — a future
 * type-test can cross-check both lists once Phase 3 lands.
 *
 * Secret hygiene: `inspect()` NEVER returns the raw value when
 * `isSecret: true`. The doctor surface uses inspections — operators
 * see "API key set / not set" but not the actual key.
 */

import os from 'node:os';

export type EnvSource = 'env' | 'default';

export interface EnvInspection {
  /** Where the resolved value came from. */
  readonly source: EnvSource;
  /**
   * Operator-safe preview. For secrets this is `'<set>'` or `'<unset>'`;
   * never the actual value. For non-secrets this is the resolved value
   * itself, truncated to 64 chars.
   */
  readonly preview: string;
  /** Marks accessors whose underlying value must not be logged or shown. */
  readonly isSecret: boolean;
}

export interface EnvAccessor<T> {
  /** Stable identifier for the doctor / telemetry surface. */
  readonly name: string;
  /** Human-readable description for `memphis doctor` output. */
  readonly description: string;
  /** Default applied when the env var is unset / blank. */
  readonly defaultValue: T;
  /** Whether the underlying value is sensitive (API keys, tokens). */
  readonly isSecret: boolean;
  /** Resolves the typed value from a raw env, applying the fallback chain. */
  read(rawEnv: NodeJS.ProcessEnv): T;
  /** Operator-facing inspection. Does NOT leak secret values. */
  inspect(rawEnv: NodeJS.ProcessEnv): EnvInspection;
}

function trim(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function previewOf(value: string, isSecret: boolean): string {
  if (isSecret) return '<set>';
  if (value.length > 64) return `${value.slice(0, 61)}…`;
  return value;
}

function defineStringAccessor(options: {
  name: string;
  envKey: string;
  description: string;
  defaultValue: string;
  isSecret?: boolean;
}): EnvAccessor<string> {
  const isSecret = options.isSecret ?? false;
  return {
    name: options.name,
    description: options.description,
    defaultValue: options.defaultValue,
    isSecret,
    read(rawEnv) {
      return trim(rawEnv[options.envKey]) ?? options.defaultValue;
    },
    inspect(rawEnv) {
      const raw = trim(rawEnv[options.envKey]);
      if (raw !== undefined) {
        return { source: 'env', preview: previewOf(raw, isSecret), isSecret };
      }
      return {
        source: 'default',
        preview: isSecret ? '<unset>' : previewOf(options.defaultValue, false),
        isSecret,
      };
    },
  };
}

function defineEnumAccessor<T extends string>(options: {
  name: string;
  envKey: string;
  description: string;
  values: readonly T[];
  defaultValue: T;
}): EnvAccessor<T> {
  const allowed = new Set<string>(options.values);
  return {
    name: options.name,
    description: options.description,
    defaultValue: options.defaultValue,
    isSecret: false,
    read(rawEnv) {
      const raw = trim(rawEnv[options.envKey]);
      if (raw && allowed.has(raw)) return raw as T;
      return options.defaultValue;
    },
    inspect(rawEnv) {
      const raw = trim(rawEnv[options.envKey]);
      if (raw && allowed.has(raw)) {
        return { source: 'env', preview: raw, isSecret: false };
      }
      return { source: 'default', preview: options.defaultValue, isSecret: false };
    },
  };
}

// ── Accessors ────────────────────────────────────────────────────────────────

export const LOG_LEVEL = defineEnumAccessor({
  name: 'LOG_LEVEL',
  envKey: 'LOG_LEVEL',
  description: 'pino logger threshold (debug | info | warn | error)',
  values: ['debug', 'info', 'warn', 'error'] as const,
  defaultValue: 'info',
});

export const NODE_ENV = defineEnumAccessor({
  name: 'NODE_ENV',
  envKey: 'NODE_ENV',
  description: 'Node.js execution mode (development | test | production)',
  values: ['development', 'test', 'production'] as const,
  defaultValue: 'development',
});

export const MEMPHIS_AGENT_NAME = defineStringAccessor({
  name: 'MEMPHIS_AGENT_NAME',
  envKey: 'MEMPHIS_AGENT_NAME',
  description: 'Operator-visible name the agent introduces itself with',
  defaultValue: 'Memphis Agent',
});

export const MEMPHIS_OWNER_NAME = defineStringAccessor({
  name: 'MEMPHIS_OWNER_NAME',
  envKey: 'MEMPHIS_OWNER_NAME',
  description: 'Operator name the agent addresses ("Your owner is …")',
  defaultValue: 'local operator',
});

/**
 * `HOME` resolution: env wins, else `os.homedir()`. Used by every
 * tilde-expansion in the runtime; centralizing it here prevents
 * "in tests we set HOME but path code reads os.homedir() directly"
 * mismatches.
 */
export const HOME = defineStringAccessor({
  name: 'HOME',
  envKey: 'HOME',
  description: 'Operator home directory (used to expand `~/`)',
  // Resolved lazily so tests that overwrite `os.homedir()` after import still
  // see the override. The defineStringAccessor closure reads .defaultValue at
  // accessor-call time, not at module-load time.
  defaultValue: os.homedir(),
});

/**
 * Voice stack mode (Sprint H, plan #2 in `docs/dev/voice-stack-decision-2026-05-04.md`).
 *
 *  - `cloud` — HuggingFace Whisper STT + MMS-TTS-Pol (or Google Cloud TTS).
 *    Network-dependent; needs `HUGGINGFACE_API_TOKEN` (or Google key).
 *  - `local` — faster-whisper STT (port 9000) + Piper TTS (port 5500).
 *    Offline-capable; needs operator to run the two HTTP servers.
 *  - `auto` (default) — local if cloud token absent, cloud if present.
 *    Fits the "demo on a network-flaky venue" use case without forcing
 *    operators with a HF token already configured into the offline path.
 */
export const MEMPHIS_VOICE_MODE = defineEnumAccessor({
  name: 'MEMPHIS_VOICE_MODE',
  envKey: 'MEMPHIS_VOICE_MODE',
  description: 'Voice stack routing: cloud (HF/Google) | local (faster-whisper + Piper) | auto',
  values: ['cloud', 'local', 'auto'] as const,
  defaultValue: 'auto',
});

/**
 * Local STT server URL (used when `MEMPHIS_VOICE_MODE` resolves to local).
 * Default targets the faster-whisper service runbook in
 * `docs/operator/voice-local-stt.md` — `python -m faster_whisper.server
 * --port 9000`.
 */
export const WHISPER_SERVER_URL = defineStringAccessor({
  name: 'WHISPER_SERVER_URL',
  envKey: 'WHISPER_SERVER_URL',
  description: 'Local STT (faster-whisper / whisper.cpp) HTTP endpoint',
  defaultValue: 'http://localhost:9000',
});

/**
 * Local TTS server URL (Piper HTTP service). Default matches the Piper
 * runbook in `docs/operator/voice-local-tts.md`.
 */
export const PIPER_SERVER_URL = defineStringAccessor({
  name: 'PIPER_SERVER_URL',
  envKey: 'PIPER_SERVER_URL',
  description: 'Local TTS (Piper) HTTP endpoint',
  defaultValue: 'http://localhost:5500',
});

/**
 * Vault encryption pepper. Combined with operator's passphrase to derive
 * the AES-256-GCM master key. Empty default — vault MUST be initialized
 * via `memphis init` before any vault read/write succeeds. The accessor
 * is marked secret so doctor + telemetry don't leak the value into
 * audit logs.
 */
export const MEMPHIS_VAULT_PEPPER = defineStringAccessor({
  name: 'MEMPHIS_VAULT_PEPPER',
  envKey: 'MEMPHIS_VAULT_PEPPER',
  description: 'Vault encryption pepper (combined with operator passphrase)',
  defaultValue: '',
  isSecret: true,
});

/**
 * Safe-mode flag. When 'true' (case-insensitive), the runtime restricts
 * write operations: no chain mutations on degraded providers, no
 * self-modify, no remote calls except via the fallback chain. Set by
 * the CLI `--safe-mode` flag (see infra/cli/index.ts) or operator's
 * `.env`.
 */
export const MEMPHIS_SAFE_MODE = defineStringAccessor({
  name: 'MEMPHIS_SAFE_MODE',
  envKey: 'MEMPHIS_SAFE_MODE',
  description: 'Restrict writes + remote calls when "true" (case-insensitive)',
  defaultValue: '',
});

/**
 * Fault injection toggle for testing. Honored by task-queue-wal +
 * a few other resilience paths. Empty / unset = off. Don't enable in
 * production — the whole point is to surface bugs.
 */
export const MEMPHIS_FAULT_INJECT = defineStringAccessor({
  name: 'MEMPHIS_FAULT_INJECT',
  envKey: 'MEMPHIS_FAULT_INJECT',
  description: 'Fault injection mode (testing only — leave unset in production)',
  defaultValue: '',
});

/**
 * Brave Search API subscription token. Used by memphis_brave_search.
 * Free tier 2000 queries/month — get one at https://api.search.brave.com/.
 * Vault refs ("VAULT:brave_api_key") are resolved upstream by
 * resolveVaultSecrets() in src/infra/cli/index.ts before any tool runs.
 * Marked secret so doctor / telemetry never log the actual key.
 */
export const BRAVE_API_KEY = defineStringAccessor({
  name: 'BRAVE_API_KEY',
  envKey: 'BRAVE_API_KEY',
  description: 'Brave Search API subscription token (or VAULT:<key> ref)',
  defaultValue: '',
  isSecret: true,
});

// ── Registry surface (for doctor + telemetry) ───────────────────────────────

/**
 * The full set of accessors registered in this module. `memphis doctor`
 * iterates over this list and calls `inspect()` on each so operators see
 * every env var Memphis actually reads. Adding an accessor above
 * REQUIRES adding it here too — the registry is the introspection
 * contract.
 */
export const ENV_REGISTRY: readonly EnvAccessor<unknown>[] = [
  LOG_LEVEL,
  NODE_ENV,
  MEMPHIS_AGENT_NAME,
  MEMPHIS_OWNER_NAME,
  HOME,
  MEMPHIS_VOICE_MODE,
  WHISPER_SERVER_URL,
  PIPER_SERVER_URL,
  MEMPHIS_VAULT_PEPPER,
  MEMPHIS_SAFE_MODE,
  MEMPHIS_FAULT_INJECT,
  BRAVE_API_KEY,
] as const;

export interface RegistryReport {
  /** Total number of registered accessors. */
  readonly count: number;
  /** Per-accessor inspection — safe to render to operator output. */
  readonly entries: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly source: EnvSource;
    readonly preview: string;
    readonly isSecret: boolean;
  }>;
}

/**
 * Build a doctor-friendly snapshot of every registered env accessor.
 * Pure: takes an env map, returns a struct. Caller decides how to
 * render (table, JSON, etc.).
 */
export function buildEnvRegistryReport(rawEnv: NodeJS.ProcessEnv): RegistryReport {
  const entries = ENV_REGISTRY.map((accessor) => {
    const inspection = accessor.inspect(rawEnv);
    return {
      name: accessor.name,
      description: accessor.description,
      source: inspection.source,
      preview: inspection.preview,
      isSecret: inspection.isSecret,
    };
  });
  return { count: entries.length, entries };
}
