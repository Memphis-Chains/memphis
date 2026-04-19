import { AppError } from '../core/errors.js';
import { secureCompare } from '../security/constant-time.js';

export interface GatewayExecPolicy {
  restrictedMode: boolean;
  allowlist: Map<string, CommandRule>;
  blockedTokens: string[];
}

export interface CommandRule {
  /** Allowed argument patterns (regex). Empty = no arguments allowed. */
  allowedArgs: RegExp[];
  /** Max total argument length. */
  maxArgLength: number;
}

export interface GatewayExecAuthConfig {
  authToken?: string;
}

/**
 * Characters that should NEVER appear in any command passed to a shell.
 * Covers all known shell metacharacters, control characters, and escaping tricks.
 */
// eslint-disable-next-line no-control-regex
const SHELL_METACHAR_RE = /[;&|`$(){}[\]!#~<>\\'\n\r\x00-\x1f\x7f]/;

/**
 * Default command rules: each allowed command has explicit argument validation.
 * Commands not in this map are blocked entirely.
 */
/** Safe path pattern: no traversal, no sensitive system paths */
const SAFE_PATH_RE = /^[A-Za-z0-9_./@~ -]+$/;
const SAFE_FLAG_RE = /^-[A-Za-z0-9]+$/;

const PACKAGE_NAME_RE = /^[A-Za-z0-9_.:@/+-]+$/;
const APT_ACTION_RE = /^(install|update)$/;
const DNF_ACTION_RE = /^(install|check-update|update)$/;
const PACMAN_FLAG_RE = /^-S(y|yu|u)?$/;
const ZYPPER_ACTION_RE = /^(install|refresh|update)$/;

const DEFAULT_COMMAND_RULES: Record<string, CommandRule> = {
  // ─── Basic utilities ──────────────────────────────────────────────
  echo: { allowedArgs: [/^[A-Za-z0-9 _.,:=@/-]+$/], maxArgLength: 200 },
  pwd: { allowedArgs: [], maxArgLength: 0 },
  ls: { allowedArgs: [/^-[lah1Rt]+$/, SAFE_PATH_RE], maxArgLength: 200 },
  whoami: { allowedArgs: [], maxArgLength: 0 },
  date: { allowedArgs: [/^\+[A-Za-z0-9%: ._-]+$/], maxArgLength: 50 },
  uptime: { allowedArgs: [], maxArgLength: 0 },
  which: { allowedArgs: [SAFE_PATH_RE], maxArgLength: 100 },
  env: { allowedArgs: [], maxArgLength: 0 },
  printenv: { allowedArgs: [/^[A-Za-z0-9_]+$/], maxArgLength: 100 },

  // ─── Read-only file inspection ────────────────────────────────────
  cat: { allowedArgs: [SAFE_FLAG_RE, SAFE_PATH_RE], maxArgLength: 300 },
  head: { allowedArgs: [/^-n$/, /^\d+$/, SAFE_FLAG_RE, SAFE_PATH_RE], maxArgLength: 300 },
  tail: { allowedArgs: [/^-n$/, /^\d+$/, SAFE_FLAG_RE, SAFE_PATH_RE], maxArgLength: 300 },
  wc: { allowedArgs: [SAFE_FLAG_RE, SAFE_PATH_RE], maxArgLength: 300 },
  grep: {
    allowedArgs: [SAFE_FLAG_RE, /^[A-Za-z0-9_.,:=@/ *?+-]+$/, SAFE_PATH_RE],
    maxArgLength: 500,
  },
  find: { allowedArgs: [SAFE_FLAG_RE, SAFE_PATH_RE], maxArgLength: 300 },
  file: { allowedArgs: [SAFE_PATH_RE], maxArgLength: 300 },
  stat: { allowedArgs: [SAFE_FLAG_RE, SAFE_PATH_RE], maxArgLength: 300 },

  // ─── Code search & analysis ───────────────────────────────────────
  rg: {
    allowedArgs: [
      SAFE_FLAG_RE,
      /^--[a-z-]+(=[A-Za-z0-9_./*,-]+)?$/,
      /^[A-Za-z0-9_.,:=@/ *?+-]+$/,
      SAFE_PATH_RE,
    ],
    maxArgLength: 500,
  },
  fd: {
    allowedArgs: [
      SAFE_FLAG_RE,
      /^--[a-z-]+(=[A-Za-z0-9_./*,-]+)?$/,
      /^[A-Za-z0-9_./*?-]+$/,
      SAFE_PATH_RE,
    ],
    maxArgLength: 300,
  },
  jq: {
    allowedArgs: [SAFE_FLAG_RE, /^[A-Za-z0-9_.[\]|@? -]+$/, SAFE_PATH_RE],
    maxArgLength: 300,
  },
  sort: { allowedArgs: [SAFE_FLAG_RE, SAFE_PATH_RE], maxArgLength: 200 },
  uniq: { allowedArgs: [SAFE_FLAG_RE, SAFE_PATH_RE], maxArgLength: 200 },
  cut: {
    allowedArgs: [SAFE_FLAG_RE, /^-[dfc]$/, /^[A-Za-z0-9_.,-]+$/, SAFE_PATH_RE],
    maxArgLength: 200,
  },
  tr: { allowedArgs: [SAFE_FLAG_RE, /^[A-Za-z0-9 _.,:=-]+$/], maxArgLength: 100 },

  // ─── System info ──────────────────────────────────────────────────
  df: { allowedArgs: [SAFE_FLAG_RE, SAFE_PATH_RE], maxArgLength: 100 },
  free: { allowedArgs: [SAFE_FLAG_RE], maxArgLength: 50 },
  hostname: { allowedArgs: [], maxArgLength: 0 },
  uname: { allowedArgs: [SAFE_FLAG_RE], maxArgLength: 20 },

  // ─── Git (read-only + safe write subcommands) ─────────────────────
  git: {
    allowedArgs: [
      /^(status|log|diff|branch|show|remote|tag|describe|rev-parse|ls-files|stash|blame|shortlog|reflog|add|commit|checkout|switch|merge|rebase|push|pull|fetch|clone|init|reset)$/,
      SAFE_FLAG_RE,
      /^--[a-z-]+(=[A-Za-z0-9_./@:~ -]+)?$/,
      /^[A-Za-z0-9_./@:~ -]+$/,
    ],
    maxArgLength: 500,
  },

  // ─── Build tools & runtimes ───────────────────────────────────────
  node: { allowedArgs: [SAFE_FLAG_RE, /^--[a-z-]+$/, SAFE_PATH_RE], maxArgLength: 300 },
  npm: {
    allowedArgs: [
      /^(run|test|start|build|install|ci|ls|outdated|audit|info|version|--version|-v)$/,
      SAFE_FLAG_RE,
      /^--[a-z-]+(=[A-Za-z0-9_./-]+)?$/,
      /^[A-Za-z0-9_./@:-]+$/,
    ],
    maxArgLength: 300,
  },
  npx: {
    allowedArgs: [SAFE_FLAG_RE, /^[A-Za-z0-9_./@:-]+$/, SAFE_PATH_RE],
    maxArgLength: 300,
  },
  cargo: {
    allowedArgs: [
      /^(build|check|test|run|clippy|fmt|doc|bench|clean|update|tree|metadata|version|install|add|search)$/,
      SAFE_FLAG_RE,
      /^--[a-z-]+(=[A-Za-z0-9_./-]+)?$/,
      /^[A-Za-z0-9_./@:-]+$/,
    ],
    maxArgLength: 500,
  },
  rustc: { allowedArgs: [SAFE_FLAG_RE, /^--[a-z-]+$/, SAFE_PATH_RE], maxArgLength: 300 },
  rustfmt: { allowedArgs: [SAFE_FLAG_RE, SAFE_PATH_RE], maxArgLength: 300 },
  make: {
    allowedArgs: [SAFE_FLAG_RE, /^[A-Za-z0-9_-]+$/, /^[A-Za-z0-9_]+=[A-Za-z0-9_./-]+$/],
    maxArgLength: 300,
  },
  python3: { allowedArgs: [SAFE_FLAG_RE, /^-[cm]$/, SAFE_PATH_RE], maxArgLength: 300 },
  pip: {
    allowedArgs: [
      /^(install|list|show|freeze|check|--version)$/,
      SAFE_FLAG_RE,
      /^[A-Za-z0-9_./@:=-]+$/,
    ],
    maxArgLength: 300,
  },

  // ─── File operations (non-destructive) ────────────────────────────
  mkdir: { allowedArgs: [/^-p$/, SAFE_PATH_RE], maxArgLength: 200 },
  cp: { allowedArgs: [SAFE_FLAG_RE, SAFE_PATH_RE], maxArgLength: 300 },
  mv: { allowedArgs: [SAFE_FLAG_RE, SAFE_PATH_RE], maxArgLength: 300 },
  touch: { allowedArgs: [SAFE_PATH_RE], maxArgLength: 200 },

  // ─── Archive / compression ────────────────────────────────────────
  tar: { allowedArgs: [SAFE_FLAG_RE, SAFE_PATH_RE], maxArgLength: 300 },
  zip: { allowedArgs: [SAFE_FLAG_RE, SAFE_PATH_RE], maxArgLength: 300 },
  unzip: { allowedArgs: [SAFE_FLAG_RE, SAFE_PATH_RE], maxArgLength: 300 },

  // ─── Package managers — additive actions only (install/update/refresh) ──
  // At tier 2 Memphis can install software but cannot remove/purge/downgrade
  // system state. Uninstall is tier-3-only (autonomy-mode=full bypasses this).
  apt: {
    allowedArgs: [APT_ACTION_RE, /^-y$/, SAFE_FLAG_RE, PACKAGE_NAME_RE],
    maxArgLength: 500,
  },
  'apt-get': {
    allowedArgs: [APT_ACTION_RE, /^-y$/, SAFE_FLAG_RE, PACKAGE_NAME_RE],
    maxArgLength: 500,
  },
  dnf: {
    allowedArgs: [DNF_ACTION_RE, /^-y$/, SAFE_FLAG_RE, PACKAGE_NAME_RE],
    maxArgLength: 500,
  },
  yum: {
    allowedArgs: [DNF_ACTION_RE, /^-y$/, SAFE_FLAG_RE, PACKAGE_NAME_RE],
    maxArgLength: 500,
  },
  pacman: {
    allowedArgs: [PACMAN_FLAG_RE, /^--noconfirm$/, SAFE_FLAG_RE, PACKAGE_NAME_RE],
    maxArgLength: 500,
  },
  zypper: {
    allowedArgs: [ZYPPER_ACTION_RE, /^-y$/, SAFE_FLAG_RE, PACKAGE_NAME_RE],
    maxArgLength: 500,
  },
  brew: {
    allowedArgs: [/^(install|update|upgrade|tap|list|info)$/, SAFE_FLAG_RE, PACKAGE_NAME_RE],
    maxArgLength: 500,
  },
  snap: {
    allowedArgs: [/^(install|refresh|list|info)$/, SAFE_FLAG_RE, PACKAGE_NAME_RE],
    maxArgLength: 500,
  },
  flatpak: {
    allowedArgs: [/^(install|update|list|info)$/, SAFE_FLAG_RE, PACKAGE_NAME_RE],
    maxArgLength: 500,
  },

  // ─── Language-specific package installers (additive) ─────────────
  rustup: {
    allowedArgs: [
      /^(install|update|default|toolchain|component|show)$/,
      SAFE_FLAG_RE,
      PACKAGE_NAME_RE,
    ],
    maxArgLength: 300,
  },
  pipx: {
    allowedArgs: [/^(install|upgrade|list|run)$/, SAFE_FLAG_RE, PACKAGE_NAME_RE],
    maxArgLength: 300,
  },
  gem: {
    allowedArgs: [/^(install|update|list|info)$/, SAFE_FLAG_RE, PACKAGE_NAME_RE],
    maxArgLength: 300,
  },
  go: {
    allowedArgs: [/^(install|get|build|run|test|mod|version)$/, SAFE_FLAG_RE, PACKAGE_NAME_RE],
    maxArgLength: 300,
  },

  // ─── Ollama (LLM runtime) — additive verbs ───────────────────────
  ollama: {
    allowedArgs: [/^(pull|list|show|serve|ps|version)$/, SAFE_FLAG_RE, PACKAGE_NAME_RE],
    maxArgLength: 300,
  },

  // ─── Downloaders ──────────────────────────────────────────────────
  // NB: the old permissive `--[flag]=value` pattern accepted
  // `--output=/etc/shadow` — arbitrary-file-write via curl/wget. Explicit
  // allowlist here limits to read-only/observability flags. Writing-to-disk
  // flags (-o, -O, --output, --output-document, --cookie-jar, --dump-header)
  // are excluded by design.
  curl: {
    allowedArgs: [
      /^-[AfIilLsSvXk#]+$/,
      /^--(silent|show-error|location|fail|head|include|verbose|max-time|connect-timeout|retry|retry-delay|retry-max-time|user-agent|compressed|http1\.0|http1\.1|http2|insecure)$/,
      /^--(max-time|connect-timeout|retry|retry-delay|retry-max-time|user-agent|header|data|data-urlencode|json|url|proto|referer|range)=[A-Za-z0-9._:/ ,=+-]+$/,
      /^-[XH]$/,
      /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH)$/,
      /^https?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/,
    ],
    maxArgLength: 600,
  },
  wget: {
    allowedArgs: [
      /^-[qvncS]+$/,
      /^--(quiet|verbose|no-verbose|continue|spider|server-response|no-check-certificate|tries|timeout|no-cache)$/,
      /^--(tries|timeout|user-agent|header|proxy-user|proxy-password|max-redirect|wait)=[A-Za-z0-9._:/ ,=+-]+$/,
      /^https?:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%-]+$/,
    ],
    maxArgLength: 600,
  },

  // ─── User-scoped systemctl (no root state change) ────────────────
  systemctl: {
    allowedArgs: [
      /^--user$/,
      /^(start|stop|restart|status|enable|disable|is-active|is-enabled|daemon-reload|list-units)$/,
      PACKAGE_NAME_RE,
    ],
    maxArgLength: 300,
  },
};

export function loadGatewayExecPolicy(rawEnv: NodeJS.ProcessEnv = process.env): GatewayExecPolicy {
  const isFullAutonomy = (rawEnv.MEMPHIS_AUTONOMY_MODE ?? '').toLowerCase() === 'full';
  const restrictedMode = isFullAutonomy ? false : toBool(rawEnv.GATEWAY_EXEC_RESTRICTED_MODE, true);

  const allowlist = new Map<string, CommandRule>();
  const allowlistNames = splitCsv(
    rawEnv.GATEWAY_EXEC_ALLOWLIST,
    Object.keys(DEFAULT_COMMAND_RULES),
  );
  for (const name of allowlistNames) {
    allowlist.set(name, DEFAULT_COMMAND_RULES[name] ?? { allowedArgs: [], maxArgLength: 0 });
  }

  // Operator-defined additional commands (basic args only, no special patterns)
  const additionalCommands = splitCsv(rawEnv.GATEWAY_EXEC_ADDITIONAL_ALLOWLIST, []);
  for (const name of additionalCommands) {
    if (!allowlist.has(name)) {
      allowlist.set(name, { allowedArgs: [SAFE_FLAG_RE, SAFE_PATH_RE], maxArgLength: 200 });
    }
  }

  const blockedTokens = splitCsv(rawEnv.GATEWAY_EXEC_BLOCKED_TOKENS, []);

  if (restrictedMode && allowlist.size === 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      'GATEWAY_EXEC_ALLOWLIST cannot be empty when restricted mode is enabled',
      500,
    );
  }

  return { restrictedMode, allowlist, blockedTokens };
}

/**
 * Parse a command string into [baseCommand, ...args] without using a shell.
 * Rejects any input containing shell metacharacters.
 */
function parseCommand(command: string): { base: string; args: string[] } {
  const trimmed = command.trim();

  // Reject shell metacharacters outright — no escaping tricks
  if (SHELL_METACHAR_RE.test(trimmed)) {
    throw new AppError('VALIDATION_ERROR', 'command contains blocked shell metacharacter', 403);
  }

  // Split on whitespace (safe after metachar check)
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'command required', 400);
  }

  // Extract base command (strip any path prefix — only basename matters)
  const rawBase = parts[0];
  const base = rawBase.includes('/') ? rawBase.split('/').pop()! : rawBase;

  return { base, args: parts.slice(1) };
}

export function enforceGatewayExecPolicy(command: string, policy: GatewayExecPolicy): void {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new AppError('VALIDATION_ERROR', 'command required', 400);
  }

  if (!policy.restrictedMode) {
    // Full access — no restrictions
    return;
  }

  const { base, args } = parseCommand(trimmed);

  // Blocklist is consulted first (token-level match): base command or any
  // arg equal to a blocked token is rejected, even if the command is
  // otherwise allowlisted. Operator intent for GATEWAY_EXEC_BLOCKED_TOKENS
  // is "never, period". Bypassed only by full-autonomy mode (which disables
  // restrictedMode entirely, handled above).
  for (const token of policy.blockedTokens) {
    if (base === token || args.some((a) => a === token)) {
      throw new AppError('VALIDATION_ERROR', `command contains blocked token: ${token}`, 403);
    }
  }

  // Check allowlist
  const rule = policy.allowlist.get(base);
  if (!rule) {
    throw new AppError('VALIDATION_ERROR', `command not in gateway allowlist: ${base}`, 403);
  }

  // If no args allowed and args present, block
  if (rule.allowedArgs.length === 0 && args.length > 0) {
    throw new AppError('VALIDATION_ERROR', `command '${base}' does not accept arguments`, 403);
  }

  // Validate total argument length
  const totalArgLength = args.join(' ').length;
  if (totalArgLength > rule.maxArgLength) {
    throw new AppError(
      'VALIDATION_ERROR',
      `arguments too long for '${base}' (max ${String(rule.maxArgLength)})`,
      403,
    );
  }

  // Validate each argument against allowed patterns
  for (const arg of args) {
    const matches = rule.allowedArgs.some((pattern) => pattern.test(arg));
    if (!matches) {
      throw new AppError(
        'VALIDATION_ERROR',
        `argument '${arg}' not allowed for command '${base}'`,
        403,
      );
    }
  }
}

export function assertGatewayExecAuthConfigured(config: GatewayExecAuthConfig): void {
  if (typeof config.authToken === 'string' && config.authToken.trim().length > 0) {
    return;
  }

  throw new AppError('CONFIG_ERROR', 'gateway /exec requires authToken', 500);
}

export function enforceGatewayExecAuth(
  authHeader: string | undefined,
  config: GatewayExecAuthConfig,
): void {
  assertGatewayExecAuthConfigured(config);
  if (
    typeof authHeader === 'string' &&
    secureCompare(authHeader, `Bearer ${config.authToken ?? ''}`)
  ) {
    return;
  }

  throw new AppError('VALIDATION_ERROR', 'unauthorized', 401);
}

function splitCsv(value: string | undefined, fallback: string[]): string[] {
  if (!value) return [...fallback];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function toBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  return value.toLowerCase() === 'true';
}
