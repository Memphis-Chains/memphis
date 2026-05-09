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

function defineNumberAccessor(options: {
  name: string;
  envKey: string;
  description: string;
  defaultValue: number;
  /** Inclusive lower bound. Values <= this fall back to the default. */
  min?: number;
  /** Inclusive upper bound. Values >= this fall back to the default. */
  max?: number;
}): EnvAccessor<number> {
  return {
    name: options.name,
    description: options.description,
    defaultValue: options.defaultValue,
    isSecret: false,
    read(rawEnv) {
      const raw = trim(rawEnv[options.envKey]);
      if (raw === undefined) return options.defaultValue;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) return options.defaultValue;
      if (options.min !== undefined && parsed < options.min) return options.defaultValue;
      if (options.max !== undefined && parsed > options.max) return options.defaultValue;
      return parsed;
    },
    inspect(rawEnv) {
      const raw = trim(rawEnv[options.envKey]);
      if (raw !== undefined) {
        const parsed = Number(raw);
        const inRange =
          Number.isFinite(parsed) &&
          (options.min === undefined || parsed >= options.min) &&
          (options.max === undefined || parsed <= options.max);
        return {
          source: inRange ? 'env' : 'default',
          preview: inRange ? String(parsed) : `${raw} (rejected, default ${options.defaultValue})`,
          isSecret: false,
        };
      }
      return {
        source: 'default',
        preview: String(options.defaultValue),
        isSecret: false,
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
 * Operator-stated requirement for the voice route. When set to `local`,
 * the doctor `ta12-voice-stack` probe escalates STT/TTS unreachability
 * to FAIL (blocking `memphis doctor` exit-zero). When unset (the default
 * for daily operator use), unreachable local engines downgrade to WARN
 * — daily users without a Whisper/Piper sidecar shouldn't see a hard
 * fail just because they didn't opt into the offline voice stack.
 *
 * Default is the empty string sentinel (no requirement). Doctor checks
 * `=== 'local'` or `=== 'cloud'` to opt into the stricter mode.
 *
 * Closure sprint Z.2.1 (2026-05-09): introduced to clear `ta12-voice-stack`
 * fail on operator setups that don't require local voice.
 */
export const MEMPHIS_VOICE_ROUTE_REQUIRED = defineEnumAccessor({
  name: 'MEMPHIS_VOICE_ROUTE_REQUIRED',
  envKey: 'MEMPHIS_VOICE_ROUTE_REQUIRED',
  description:
    'When set to "local" or "cloud", doctor escalates voice-stack unreachability to FAIL for the named route',
  values: ['cloud', 'local', ''] as const,
  defaultValue: '',
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
 * Tesseract OCR languages, as the `-l` flag value passed to the
 * tesseract CLI. Default `pol+eng` covers Polish operator screenshots
 * with English fallback. Operators with other locales can override via
 * .env — install the matching `tesseract-ocr-<lang>` package first.
 */
export const MEMPHIS_OCR_LANG = defineStringAccessor({
  name: 'MEMPHIS_OCR_LANG',
  envKey: 'MEMPHIS_OCR_LANG',
  description: 'Tesseract -l language pack(s) for image OCR',
  defaultValue: 'pol+eng',
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

// ── Sync (Sprint ι batch D5) ────────────────────────────────────────────────

/**
 * Pinata IPFS API key (paid pinning service). Used by `src/sync/ipfs.ts`
 * for content publication. Empty = sync layer skips IPFS upload.
 */
export const PINATA_API_KEY = defineStringAccessor({
  name: 'PINATA_API_KEY',
  envKey: 'PINATA_API_KEY',
  description: 'Pinata IPFS API key (paid pinning)',
  defaultValue: '',
  isSecret: true,
});

export const PINATA_SECRET_API_KEY = defineStringAccessor({
  name: 'PINATA_SECRET_API_KEY',
  envKey: 'PINATA_SECRET_API_KEY',
  description: 'Pinata IPFS API secret',
  defaultValue: '',
  isSecret: true,
});

export const PINATA_GATEWAY_URL = defineStringAccessor({
  name: 'PINATA_GATEWAY_URL',
  envKey: 'PINATA_GATEWAY_URL',
  description: 'Pinata gateway base URL',
  defaultValue: 'https://api.pinata.cloud',
});

/**
 * Operator's DID for sync envelopes (trade.ts). Falls back to
 * `did:memphis:unknown` if neither operator option nor env supplies one.
 * Sprint η.1's `memphis identity init` writes a real DID; this env
 * accessor stays as a hand-override path.
 */
export const MEMPHIS_DID = defineStringAccessor({
  name: 'MEMPHIS_DID',
  envKey: 'MEMPHIS_DID',
  description: 'Operator DID override (defaults to identity file or unknown)',
  defaultValue: '',
});

/**
 * Comma-separated list of sync peer URLs for agent-registry. Empty
 * disables peer discovery.
 */
export const MEMPHIS_SYNC_PEERS = defineStringAccessor({
  name: 'MEMPHIS_SYNC_PEERS',
  envKey: 'MEMPHIS_SYNC_PEERS',
  description: 'Comma-separated sync peer URLs',
  defaultValue: '',
});

/**
 * If "true", sync-manager accepts unsigned envelopes (dev/testing
 * only — production should sign). Default false.
 */
export const MEMPHIS_SYNC_ACCEPT_UNSIGNED = defineStringAccessor({
  name: 'MEMPHIS_SYNC_ACCEPT_UNSIGNED',
  envKey: 'MEMPHIS_SYNC_ACCEPT_UNSIGNED',
  description: 'Accept unsigned sync envelopes (dev only — "true" enables)',
  defaultValue: 'false',
});

/**
 * MiniMax provider request timeout. Phase 1 P4 hotfix: the 2026-05-08
 * runtime diagnostic saw the live MiniMax client die mid-stream with
 * "timed out reading response" — the underlying fetch call had no
 * AbortSignal at all. Default 30 minutes accommodates 2-week
 * cost-unconstrained reasoning sessions; sanity rail capped at 24h.
 */
export const MINIMAX_REQUEST_TIMEOUT_MS = defineNumberAccessor({
  name: 'MINIMAX_REQUEST_TIMEOUT_MS',
  envKey: 'MINIMAX_REQUEST_TIMEOUT_MS',
  description: 'MiniMax chat/completions request timeout (ms). Default 30 min, max 24 h.',
  defaultValue: 1_800_000,
  min: 1_000,
  max: 86_400_000,
});

// ── Phase 1.5 limit-bump accessors (autopilot 2026-05-08) ──────────────────
//
// All defaults track LIMITS-MATRIX-2026-05-08 §4–§7. Operator constraint:
// limits are safety nets, not budgets. Memphis must work two weeks on a
// single question without artificial cutoff. Min/max bounds are physical
// sanity rails — the runtime falls back to default when the env value is
// out of range so an operator typo can't accidentally disable a limit.

export const MEMPHIS_LOOP_MAX_STEPS = defineNumberAccessor({
  name: 'MEMPHIS_LOOP_MAX_STEPS',
  envKey: 'MEMPHIS_CHAT_MAX_STEPS',
  description: 'Max loop steps per agent session. Default 1000.',
  defaultValue: 1_000,
  min: 1,
  max: 100_000,
});

export const MEMPHIS_LOOP_MAX_TOOL_CALLS = defineNumberAccessor({
  name: 'MEMPHIS_LOOP_MAX_TOOL_CALLS',
  envKey: 'MEMPHIS_CHAT_MAX_TOOL_CALLS',
  description: 'Max tool calls per agent session. Default 1024.',
  defaultValue: 1_024,
  min: 1,
  max: 100_000,
});

export const MEMPHIS_LOOP_MAX_ERRORS = defineNumberAccessor({
  name: 'MEMPHIS_LOOP_MAX_ERRORS',
  envKey: 'MEMPHIS_CHAT_MAX_ERRORS',
  description: 'Tolerated tool errors per agent session before halt. Default 32.',
  defaultValue: 32,
  min: 1,
  max: 10_000,
});

export const MEMPHIS_CHAT_MAX_MESSAGES = defineNumberAccessor({
  name: 'MEMPHIS_CHAT_MAX_MESSAGES',
  envKey: 'MEMPHIS_CHAT_MAX_MESSAGES',
  description: 'Chat history window (messages retained). Default 10000.',
  defaultValue: 10_000,
  min: 10,
  max: 1_000_000,
});

export const MEMPHIS_GEN_TIMEOUT_MS = defineNumberAccessor({
  name: 'MEMPHIS_GEN_TIMEOUT_MS',
  envKey: 'GEN_TIMEOUT_MS',
  description: 'Per-request generation timeout (ms). Default 1 h, max 24 h.',
  defaultValue: 3_600_000,
  min: 100,
  max: 86_400_000,
});

export const MEMPHIS_GEN_MAX_TOKENS = defineNumberAccessor({
  name: 'MEMPHIS_GEN_MAX_TOKENS',
  envKey: 'MEMPHIS_GEN_MAX_TOKENS',
  description:
    'Per-request output tokens. Default 2048 (pre-Phase-1.5 safe value); operator opts higher via env if their provider endpoint supports it. Sanity-rail max 1MB.',
  // Phase 1.5.1 set this to 32_768 under the "cost-unconstrained" mandate
  // — the model spec said 32k+ output was supported. Live operator
  // session 2026-05-08 caught the gap: MiniMax M2.7 endpoint operator
  // uses imposes a server-side per-request output cap that's much smaller
  // (the rejection says "context window exceeds limit (2013)" — i.e. the
  // remaining context after prompt is ~2013 tokens, and our 32768
  // max_tokens parameter overshoots that).
  //
  // Conservative default 2048 mirrors the pre-Phase-1.5 hardcoded value
  // that worked across providers without rejection. Operators with
  // beefier endpoint allowances can opt up via the env var:
  //   MEMPHIS_GEN_MAX_TOKENS=8192 memphis chat ...
  // The schema cap stays at 1MB for the upper-end providers (Anthropic
  // 64k, OpenRouter 100k, etc) so the env-driven opt-up isn't artificially
  // constrained here.
  defaultValue: 2_048,
  min: 1,
  max: 1_048_576,
});

export const MEMPHIS_STT_TIMEOUT_MS = defineNumberAccessor({
  name: 'MEMPHIS_STT_TIMEOUT_MS',
  envKey: 'MEMPHIS_STT_TIMEOUT_MS',
  description: 'STT (Whisper) request timeout (ms). Default 10 min.',
  defaultValue: 600_000,
  min: 1_000,
  max: 86_400_000,
});

export const MEMPHIS_TTS_TIMEOUT_MS = defineNumberAccessor({
  name: 'MEMPHIS_TTS_TIMEOUT_MS',
  envKey: 'MEMPHIS_TTS_TIMEOUT_MS',
  description: 'TTS (Piper) request timeout (ms). Default 5 min.',
  defaultValue: 300_000,
  min: 1_000,
  max: 86_400_000,
});

export const MEMPHIS_PIPER_HEALTH_TIMEOUT_MS = defineNumberAccessor({
  name: 'MEMPHIS_PIPER_HEALTH_TIMEOUT_MS',
  envKey: 'MEMPHIS_PIPER_HEALTH_TIMEOUT_MS',
  description: 'Piper health probe timeout (ms). Default 30 s.',
  defaultValue: 30_000,
  min: 100,
  max: 600_000,
});

export const MEMPHIS_EXEC_TIMEOUT_MS = defineNumberAccessor({
  name: 'MEMPHIS_EXEC_TIMEOUT_MS',
  envKey: 'MEMPHIS_EXEC_TIMEOUT_MS',
  description: 'memphis_exec tool timeout (ms). Default 1 h.',
  defaultValue: 3_600_000,
  min: 1_000,
  max: 86_400_000,
});

export const MEMPHIS_BUILD_TIMEOUT_MS = defineNumberAccessor({
  name: 'MEMPHIS_BUILD_TIMEOUT_MS',
  envKey: 'MEMPHIS_BUILD_TIMEOUT_MS',
  description: 'memphis_build tool timeout (ms). Default 2 h.',
  defaultValue: 7_200_000,
  min: 1_000,
  max: 86_400_000,
});

export const MEMPHIS_PACKAGE_TIMEOUT_MS = defineNumberAccessor({
  name: 'MEMPHIS_PACKAGE_TIMEOUT_MS',
  envKey: 'MEMPHIS_PACKAGE_TIMEOUT_MS',
  description: 'memphis_package (npm/cargo) tool timeout (ms). Default 1 h.',
  defaultValue: 3_600_000,
  min: 1_000,
  max: 86_400_000,
});

export const MEMPHIS_WEB_FETCH_TIMEOUT_MS = defineNumberAccessor({
  name: 'MEMPHIS_WEB_FETCH_TIMEOUT_MS',
  envKey: 'MEMPHIS_WEB_FETCH_TIMEOUT_MS',
  description: 'memphis_web_fetch tool timeout (ms). Default 1 min.',
  defaultValue: 60_000,
  min: 1_000,
  max: 600_000,
});

export const MEMPHIS_BRAVE_SEARCH_TIMEOUT_MS = defineNumberAccessor({
  name: 'MEMPHIS_BRAVE_SEARCH_TIMEOUT_MS',
  envKey: 'MEMPHIS_BRAVE_SEARCH_TIMEOUT_MS',
  description: 'memphis_brave_search tool timeout (ms). Default 1 min.',
  defaultValue: 60_000,
  min: 1_000,
  max: 600_000,
});

export const MEMPHIS_WEB_SEARCH_TIMEOUT_MS = defineNumberAccessor({
  name: 'MEMPHIS_WEB_SEARCH_TIMEOUT_MS',
  envKey: 'MEMPHIS_WEB_SEARCH_TIMEOUT_MS',
  description: 'memphis_web_search tool timeout (ms). Default 1 min.',
  defaultValue: 60_000,
  min: 1_000,
  max: 600_000,
});

export const MEMPHIS_TUI_HOST_HANDSHAKE_TIMEOUT_MS = defineNumberAccessor({
  name: 'MEMPHIS_TUI_HOST_HANDSHAKE_TIMEOUT_MS',
  envKey: 'MEMPHIS_TUI_HOST_HANDSHAKE_TIMEOUT_MS',
  description: 'TUI host handshake timeout (ms). Default 2 min.',
  defaultValue: 120_000,
  min: 1_000,
  max: 600_000,
});

export const MEMPHIS_TUI_HOST_REQUEST_START_TIMEOUT_MS = defineNumberAccessor({
  name: 'MEMPHIS_TUI_HOST_REQUEST_START_TIMEOUT_MS',
  envKey: 'MEMPHIS_TUI_HOST_REQUEST_START_TIMEOUT_MS',
  description: 'TUI host request-start timeout (ms). Default 1 min.',
  defaultValue: 60_000,
  min: 1_000,
  max: 600_000,
});

export const MEMPHIS_TUI_HOST_REQUEST_IDLE_TIMEOUT_MS = defineNumberAccessor({
  name: 'MEMPHIS_TUI_HOST_REQUEST_IDLE_TIMEOUT_MS',
  envKey: 'MEMPHIS_TUI_HOST_REQUEST_IDLE_TIMEOUT_MS',
  description: 'TUI host idle-during-request timeout (ms). Default 30 min.',
  defaultValue: 1_800_000,
  min: 1_000,
  max: 86_400_000,
});

export const MEMPHIS_CATEGORIZER_LLM_TIMEOUT_MS = defineNumberAccessor({
  name: 'MEMPHIS_CATEGORIZER_LLM_TIMEOUT_MS',
  envKey: 'MEMPHIS_CATEGORIZER_LLM_TIMEOUT_MS',
  description: 'Categorizer LLM call timeout (ms). Default 1 min (was 3 s legacy setTimeout).',
  defaultValue: 60_000,
  min: 1_000,
  max: 600_000,
});

// Phase 1.5.3 closeout (autopilot 2026-05-08, post-v1.9.1): residual 4
// timeouts that fell out of the original sweep because no env accessor
// existed yet. send/git are short by design (10/30 s), but operator may
// want longer windows for slow networks; OCR/vision are 90 s and benefit
// from the same cost-unconstrained rules as STT.

export const MEMPHIS_SEND_TIMEOUT_MS = defineNumberAccessor({
  name: 'MEMPHIS_SEND_TIMEOUT_MS',
  envKey: 'MEMPHIS_SEND_TIMEOUT_MS',
  description: 'memphis_send (Telegram etc) tool timeout (ms). Default 1 min.',
  defaultValue: 60_000,
  min: 1_000,
  max: 600_000,
});

export const MEMPHIS_GIT_TIMEOUT_MS = defineNumberAccessor({
  name: 'MEMPHIS_GIT_TIMEOUT_MS',
  envKey: 'MEMPHIS_GIT_TIMEOUT_MS',
  description: 'memphis_git tool timeout (ms). Default 10 min.',
  defaultValue: 600_000,
  min: 1_000,
  max: 3_600_000,
});

export const MEMPHIS_OCR_TIMEOUT_MS = defineNumberAccessor({
  name: 'MEMPHIS_OCR_TIMEOUT_MS',
  envKey: 'MEMPHIS_OCR_TIMEOUT_MS',
  description: 'OCR (Tesseract) request timeout (ms). Default 10 min.',
  defaultValue: 600_000,
  min: 1_000,
  max: 86_400_000,
});

export const MEMPHIS_VISION_TIMEOUT_MS = defineNumberAccessor({
  name: 'MEMPHIS_VISION_TIMEOUT_MS',
  envKey: 'MEMPHIS_VISION_TIMEOUT_MS',
  description: 'Vision (moondream) request timeout (ms). Default 10 min.',
  defaultValue: 600_000,
  min: 1_000,
  max: 86_400_000,
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
  MEMPHIS_OCR_LANG,
  MEMPHIS_VAULT_PEPPER,
  MEMPHIS_SAFE_MODE,
  MEMPHIS_FAULT_INJECT,
  BRAVE_API_KEY,
  PINATA_API_KEY,
  PINATA_SECRET_API_KEY,
  PINATA_GATEWAY_URL,
  MEMPHIS_DID,
  MEMPHIS_SYNC_PEERS,
  MEMPHIS_SYNC_ACCEPT_UNSIGNED,
  MINIMAX_REQUEST_TIMEOUT_MS,
  MEMPHIS_LOOP_MAX_STEPS,
  MEMPHIS_LOOP_MAX_TOOL_CALLS,
  MEMPHIS_LOOP_MAX_ERRORS,
  MEMPHIS_CHAT_MAX_MESSAGES,
  MEMPHIS_GEN_TIMEOUT_MS,
  MEMPHIS_GEN_MAX_TOKENS,
  MEMPHIS_STT_TIMEOUT_MS,
  MEMPHIS_TTS_TIMEOUT_MS,
  MEMPHIS_PIPER_HEALTH_TIMEOUT_MS,
  MEMPHIS_EXEC_TIMEOUT_MS,
  MEMPHIS_BUILD_TIMEOUT_MS,
  MEMPHIS_PACKAGE_TIMEOUT_MS,
  MEMPHIS_WEB_FETCH_TIMEOUT_MS,
  MEMPHIS_BRAVE_SEARCH_TIMEOUT_MS,
  MEMPHIS_WEB_SEARCH_TIMEOUT_MS,
  MEMPHIS_TUI_HOST_HANDSHAKE_TIMEOUT_MS,
  MEMPHIS_TUI_HOST_REQUEST_START_TIMEOUT_MS,
  MEMPHIS_TUI_HOST_REQUEST_IDLE_TIMEOUT_MS,
  MEMPHIS_CATEGORIZER_LLM_TIMEOUT_MS,
  MEMPHIS_SEND_TIMEOUT_MS,
  MEMPHIS_GIT_TIMEOUT_MS,
  MEMPHIS_OCR_TIMEOUT_MS,
  MEMPHIS_VISION_TIMEOUT_MS,
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
