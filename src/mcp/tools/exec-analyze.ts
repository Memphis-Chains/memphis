/**
 * memphis_exec_analyze — REV2 Temat 3.5.
 *
 * Pre-exec inspection tool. The LLM calls this BEFORE memphis_exec when
 * the command isn't obviously read-only — surfaces predicted impact so
 * the agent can decide whether to (a) just run, (b) dry-run first,
 * (c) ask the operator, or (d) refuse.
 *
 * Pure parser + heuristics. Returns analysis without ever invoking the
 * underlying command. Safe to call at any tier (read-only).
 *
 * Anti-confab note: the analysis is a hint, not a contract. A
 * command marked `idempotent` can still fail or surprise; the agent
 * is expected to verify post-exec, not assume.
 */

export type SideEffectKind =
  | 'read-only'
  | 'local-write'
  | 'system-state'
  | 'network'
  | 'irreversible';

export type Reversibility = 'idempotent' | 'reversible' | 'irreversible' | 'unknown';

export type ExecAnalyzeRecommendation =
  | 'safe-to-run'
  | 'analyze-then-run'
  | 'ask-operator'
  | 'refuse';

export interface MemphisExecAnalyzeInput {
  command: string;
  /** Optional operator-stated intent — surfaced unchanged for audit. */
  surface_intent?: string;
}

export interface MemphisExecAnalyzeOutput {
  parsed: { base: string; args: string[] };
  semantic: string;
  side_effects: SideEffectKind;
  files_touched: string[];
  reversibility: Reversibility;
  tier_required: 2 | 3;
  dry_run_command?: string;
  warnings: string[];
  recommendation: ExecAnalyzeRecommendation;
  surface_intent?: string;
}

interface CommandProfile {
  /** Base command name(s) this profile matches (lowercase, leading binary). */
  base: readonly string[];
  semantic: string;
  side_effects: SideEffectKind;
  reversibility: Reversibility;
  tier_required: 2 | 3;
  /** When set, the analyzer suggests a dry-run flavour to try first. */
  dryRunMutator?: (args: string[]) => string | undefined;
  /** Extra warnings keyed on argument shape (e.g. `--force` present). */
  warnings?: (args: string[]) => string[];
}

const READ_ONLY_BASES = new Set([
  'ls',
  'pwd',
  'echo',
  'cat',
  'head',
  'tail',
  'wc',
  'file',
  'stat',
  'du',
  'df',
  'free',
  'uptime',
  'date',
  'whoami',
  'id',
  'env',
  'printenv',
  'which',
  'whereis',
  'type',
  'history',
  'tree',
  'tldr',
  'man',
  'help',
  'less',
  'more',
  'grep',
  'rg',
  'awk',
  'sed', // sed without `-i` is read-only; -i is caught by warning
  'find', // safe unless -exec / -delete
  'fd',
  'fdfind',
  'jq',
  'yq',
  'true',
  'false',
  'test',
  'ps',
  'top',
  'htop',
  'pgrep',
  'pidof',
  'lsof',
  'netstat',
  'ss',
  'ip',
  'ifconfig',
  'ping',
  'nslookup',
  'dig',
  'host',
]);

const GIT_SAFE_SUBS = new Set([
  'status',
  'log',
  'show',
  'diff',
  'blame',
  'branch', // listing branches; `-D` caught below
  'remote',
  'config', // reading; `--add`/`--set` caught below
  'describe',
  'rev-parse',
  'rev-list',
  'shortlog',
  'stash',
  'tag', // listing; create caught below
  'reflog',
  'ls-files',
  'ls-tree',
  'cat-file',
  'merge-base',
]);

const GIT_DESTRUCTIVE_SUBS = new Set([
  'reset',
  'clean',
  'rebase',
  'cherry-pick',
  'push',
  'rm',
  'filter-branch',
]);

const NPM_READ_SUBS = new Set([
  'list',
  'ls',
  'view',
  'info',
  'audit',
  'doctor',
  'config get',
  'help',
  'version',
  'whoami',
  'outdated',
]);

const PROTECTED_PATHS = [
  /\.memphis\/vault\b/i,
  /\.memphis\/keys\b/i,
  /(^|\/|=)\.env(\b|\.)/,
  /(^|\/)signing-seed\.bin\b/,
  // Block-device patterns — match anywhere in the arg so `of=/dev/sda`
  // (dd argument form) registers. We're hunting these regardless of
  // how the path is embedded.
  /\/dev\/sd[a-z]\b/,
  /\/dev\/nvme/,
  /\/dev\/mapper\//,
  /\/dev\/disk\//,
];

const PROFILES: readonly CommandProfile[] = [
  {
    base: ['rm'],
    semantic: 'remove files/directories',
    side_effects: 'irreversible',
    reversibility: 'irreversible',
    tier_required: 3,
    warnings: (args) => {
      const w: string[] = [];
      if (args.includes('-rf') || (args.includes('-r') && args.includes('-f'))) {
        w.push('recursive force delete — no undo');
      }
      if (args.includes('--no-preserve-root')) {
        w.push('--no-preserve-root: actively dangerous');
      }
      return w;
    },
  },
  {
    base: ['dd'],
    semantic: 'low-level block copy / disk wipe',
    side_effects: 'irreversible',
    reversibility: 'irreversible',
    tier_required: 3,
    warnings: () => ['dd to a device path is permanent data loss'],
  },
  {
    base: ['mkfs', 'mkfs.ext4', 'mkfs.xfs', 'mkfs.btrfs', 'mkfs.fat'],
    semantic: 'format filesystem',
    side_effects: 'irreversible',
    reversibility: 'irreversible',
    tier_required: 3,
    warnings: () => ['formatting destroys all data on the target'],
  },
  {
    base: ['shred'],
    semantic: 'overwrite file content to make recovery impossible',
    side_effects: 'irreversible',
    reversibility: 'irreversible',
    tier_required: 3,
  },
  {
    base: ['apt', 'apt-get', 'dpkg'],
    semantic: 'system package management',
    side_effects: 'system-state',
    reversibility: 'reversible', // apt remove / dpkg --remove
    tier_required: 3,
    warnings: (args) => {
      if (args.includes('purge') || args.includes('--purge')) {
        return ['--purge removes config files; only partially reversible'];
      }
      return [];
    },
  },
  {
    base: ['systemctl', 'service'],
    semantic: 'systemd service control',
    side_effects: 'system-state',
    reversibility: 'reversible',
    tier_required: 3,
  },
  {
    base: ['mv'],
    semantic: 'move/rename file or directory',
    side_effects: 'local-write',
    reversibility: 'reversible',
    tier_required: 2,
  },
  {
    base: ['cp'],
    semantic: 'copy file or directory',
    side_effects: 'local-write',
    reversibility: 'reversible',
    tier_required: 2,
  },
  {
    base: ['mkdir'],
    semantic: 'create directory',
    side_effects: 'local-write',
    reversibility: 'reversible',
    tier_required: 2,
  },
  {
    base: ['touch'],
    semantic: 'create empty file or update timestamp',
    side_effects: 'local-write',
    reversibility: 'reversible',
    tier_required: 2,
  },
  {
    base: ['chmod', 'chown', 'chgrp'],
    semantic: 'change file ownership/permissions',
    side_effects: 'local-write',
    reversibility: 'reversible',
    tier_required: 2,
  },
  {
    base: ['curl', 'wget'],
    semantic: 'HTTP/HTTPS request',
    side_effects: 'network',
    reversibility: 'idempotent', // for GETs; POSTs are server-side
    tier_required: 2,
    warnings: (args) => {
      const w: string[] = [];
      if (args.includes('-X') || args.includes('--request')) {
        w.push('non-GET method — may have server-side side effects');
      }
      if (args.includes('-d') || args.includes('--data')) {
        w.push('payload body — likely POST/PUT/PATCH');
      }
      return w;
    },
  },
  {
    base: ['ssh', 'scp', 'rsync'],
    semantic: 'remote shell / file transfer',
    side_effects: 'network',
    reversibility: 'unknown',
    tier_required: 3,
    dryRunMutator: (args) => {
      // rsync supports --dry-run
      const cmd = args[0] ?? '';
      if (cmd.startsWith('rsync')) {
        return `rsync --dry-run ${args.slice(1).join(' ')}`;
      }
      return undefined;
    },
  },
  {
    base: ['cargo'],
    semantic: 'Rust build / test',
    side_effects: 'local-write',
    reversibility: 'idempotent',
    tier_required: 2,
  },
  {
    base: ['make'],
    semantic: 'invoke Makefile target',
    side_effects: 'local-write',
    reversibility: 'unknown',
    tier_required: 2,
  },
  {
    base: ['docker', 'podman'],
    semantic: 'container runtime',
    side_effects: 'system-state',
    reversibility: 'reversible',
    tier_required: 3,
  },
  {
    base: ['sudo', 'doas'],
    semantic: 'elevated execution',
    side_effects: 'system-state',
    reversibility: 'unknown',
    tier_required: 3,
    warnings: () => ['sudo: full root authority on the spawned command'],
  },
];

interface ParsedCommand {
  base: string;
  args: string[];
}

export function parseCommand(command: string): ParsedCommand {
  const trimmed = command.trim();
  // Split on whitespace, ignoring quoted substrings (simple-pass; the
  // full shell grammar isn't needed here — we just want the base and
  // a flat arg list good enough for heuristics).
  const tokens: string[] = [];
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (ch === ' ' || ch === '\t') {
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      const start = i;
      while (i < trimmed.length && trimmed[i] !== quote) i += 1;
      tokens.push(trimmed.slice(start, i));
      if (i < trimmed.length) i += 1;
      continue;
    }
    const start = i;
    while (i < trimmed.length && trimmed[i] !== ' ' && trimmed[i] !== '\t') i += 1;
    tokens.push(trimmed.slice(start, i));
  }
  const [base, ...args] = tokens;
  return { base: (base ?? '').toLowerCase(), args };
}

function findProfile(base: string): CommandProfile | undefined {
  return PROFILES.find((p) => p.base.includes(base));
}

function classifyGit(args: string[]): {
  semantic: string;
  side_effects: SideEffectKind;
  reversibility: Reversibility;
  tier_required: 2 | 3;
  warnings: string[];
} {
  const sub = args[0] ?? '';
  if (GIT_SAFE_SUBS.has(sub)) {
    // Special cases on the sub itself
    if (
      sub === 'branch' &&
      (args.includes('-d') || args.includes('-D') || args.includes('--delete'))
    ) {
      return {
        semantic: 'git: delete branch',
        side_effects: 'local-write',
        reversibility: 'reversible', // git reflog
        tier_required: 2,
        warnings: ['branch deletion (recoverable via reflog within 90 days default)'],
      };
    }
    if (sub === 'config' && (args.includes('--add') || args.includes('--set'))) {
      return {
        semantic: 'git: write config',
        side_effects: 'local-write',
        reversibility: 'reversible',
        tier_required: 2,
        warnings: [],
      };
    }
    return {
      semantic: `git: ${sub} (read)`,
      side_effects: 'read-only',
      reversibility: 'idempotent',
      tier_required: 2,
      warnings: [],
    };
  }
  if (GIT_DESTRUCTIVE_SUBS.has(sub)) {
    const warnings: string[] = [];
    if (sub === 'reset' && (args.includes('--hard') || args.includes('--keep'))) {
      warnings.push('git reset --hard: discards uncommitted changes (no reflog for them)');
    }
    if (sub === 'clean' && args.includes('-f')) {
      warnings.push('git clean -f: discards untracked files unrecoverably');
    }
    if (sub === 'push' && args.includes('--force')) {
      warnings.push('git push --force: rewrites remote history');
    }
    if (sub === 'rm') {
      warnings.push('removes file from working tree + index');
    }
    return {
      semantic: `git: ${sub} (write)`,
      side_effects: 'local-write',
      reversibility: warnings.length > 0 ? 'unknown' : 'reversible',
      tier_required: 2,
      warnings,
    };
  }
  // Unknown git subcommand
  return {
    semantic: `git: ${sub || '<no-sub>'} (unclassified)`,
    side_effects: 'local-write',
    reversibility: 'unknown',
    tier_required: 2,
    warnings: ['unrecognised git subcommand — review manually'],
  };
}

function classifyNpm(args: string[]): {
  semantic: string;
  side_effects: SideEffectKind;
  reversibility: Reversibility;
  tier_required: 2 | 3;
  warnings: string[];
} {
  const sub = args[0] ?? '';
  if (NPM_READ_SUBS.has(sub)) {
    return {
      semantic: `npm: ${sub} (read)`,
      side_effects: 'read-only',
      reversibility: 'idempotent',
      tier_required: 2,
      warnings: [],
    };
  }
  if (sub === 'install' || sub === 'i' || sub === 'add') {
    return {
      semantic: `npm: ${sub} (install)`,
      side_effects: 'local-write',
      reversibility: 'reversible',
      tier_required: 2,
      warnings: ['mutates node_modules + package-lock.json'],
    };
  }
  if (sub === 'run' || sub === 'test') {
    return {
      semantic: `npm: ${sub} <script>`,
      side_effects: 'local-write', // depends on the script
      reversibility: 'unknown',
      tier_required: 2,
      warnings: ['effect depends on the npm script body'],
    };
  }
  if (sub === 'publish') {
    return {
      semantic: 'npm: publish',
      side_effects: 'irreversible',
      reversibility: 'irreversible',
      tier_required: 3,
      warnings: ['publishing a package version is permanent (unpublish has narrow window)'],
    };
  }
  return {
    semantic: `npm: ${sub || '<no-sub>'} (unclassified)`,
    side_effects: 'local-write',
    reversibility: 'unknown',
    tier_required: 2,
    warnings: ['unrecognised npm subcommand'],
  };
}

function findTouchedPaths(args: string[]): string[] {
  // Heuristic: args that look like paths (contain / or .). Filters out
  // flags (start with -). Keeps shell glob patterns verbatim.
  return args.filter((a) => {
    if (a.startsWith('-')) return false;
    if (a.includes('/') || /\.[a-z0-9]+$/i.test(a)) return true;
    return false;
  });
}

function detectProtectedHits(touched: string[]): string[] {
  const hits: string[] = [];
  for (const path of touched) {
    for (const re of PROTECTED_PATHS) {
      if (re.test(path)) {
        hits.push(path);
        break;
      }
    }
  }
  return hits;
}

function deriveDryRun(base: string, args: string[]): string | undefined {
  if (base === 'rm') {
    // GNU coreutils rm has no real --dry-run, but `ls -la` against the
    // same targets is a useful preview.
    if (args.length === 0) return undefined;
    return `ls -la ${args.filter((a) => !a.startsWith('-')).join(' ')}`;
  }
  if (base === 'rsync') return `rsync --dry-run ${args.join(' ')}`;
  if (base === 'mv') return undefined; // No standard dry-run; ls preview not useful
  if (base === 'apt' || base === 'apt-get') {
    return `${base} -s ${args.join(' ')}`; // -s = simulate
  }
  if (base === 'cp') {
    return undefined;
  }
  return undefined;
}

function recommend(
  base: string,
  sideEffects: SideEffectKind,
  reversibility: Reversibility,
  warnings: string[],
  protectedHits: string[],
): ExecAnalyzeRecommendation {
  if (protectedHits.length > 0) return 'refuse';
  if (sideEffects === 'read-only') return 'safe-to-run';
  if (reversibility === 'irreversible') return 'ask-operator';
  if (warnings.length >= 2) return 'analyze-then-run';
  if (sideEffects === 'system-state' || sideEffects === 'network') return 'analyze-then-run';
  // base unknown + non-readonly → cautious
  if (!READ_ONLY_BASES.has(base) && !findProfile(base) && base !== 'git' && base !== 'npm') {
    return 'analyze-then-run';
  }
  return 'safe-to-run';
}

export function runMemphisExecAnalyze(
  input: MemphisExecAnalyzeInput,
): MemphisExecAnalyzeOutput {
  const parsed = parseCommand(input.command);
  const { base, args } = parsed;

  if (!base) {
    return {
      parsed,
      semantic: 'empty command',
      side_effects: 'read-only',
      files_touched: [],
      reversibility: 'idempotent',
      tier_required: 2,
      warnings: ['empty command after parsing'],
      recommendation: 'refuse',
      ...(input.surface_intent ? { surface_intent: input.surface_intent } : {}),
    };
  }

  // git / npm get richer subcommand-level routing.
  let semantic: string;
  let side_effects: SideEffectKind;
  let reversibility: Reversibility;
  let tier_required: 2 | 3;
  let warnings: string[] = [];

  if (base === 'git') {
    const g = classifyGit(args);
    semantic = g.semantic;
    side_effects = g.side_effects;
    reversibility = g.reversibility;
    tier_required = g.tier_required;
    warnings = g.warnings;
  } else if (base === 'npm' || base === 'pnpm' || base === 'yarn') {
    const n = classifyNpm(args);
    semantic = n.semantic;
    side_effects = n.side_effects;
    reversibility = n.reversibility;
    tier_required = n.tier_required;
    warnings = n.warnings;
  } else if (READ_ONLY_BASES.has(base)) {
    semantic = `${base}: read-only inspection`;
    side_effects = 'read-only';
    reversibility = 'idempotent';
    tier_required = 2;
    // Special read-only-with-caveats
    if (base === 'sed' && (args.includes('-i') || args.some((a) => a.startsWith('-i')))) {
      side_effects = 'local-write';
      reversibility = 'reversible';
      warnings.push('sed -i: in-place edit, not strictly read-only');
    }
    if (
      base === 'find' &&
      (args.includes('-delete') || args.includes('-exec') || args.includes('-execdir'))
    ) {
      side_effects = 'local-write';
      reversibility = 'unknown';
      warnings.push('find with -delete/-exec: actually mutates the filesystem');
    }
  } else {
    const profile = findProfile(base);
    if (profile) {
      semantic = profile.semantic;
      side_effects = profile.side_effects;
      reversibility = profile.reversibility;
      tier_required = profile.tier_required;
      warnings = profile.warnings ? profile.warnings(args) : [];
    } else {
      // Unknown base
      semantic = `${base}: unclassified command`;
      side_effects = 'local-write';
      reversibility = 'unknown';
      tier_required = 2;
      warnings = ['unrecognised command — treating as unknown-impact'];
    }
  }

  // Universal --force / -f hardening warning for write commands.
  if (
    side_effects !== 'read-only' &&
    (args.includes('--force') || args.includes('-f')) &&
    base !== 'cargo' &&
    base !== 'cp' &&
    base !== 'mv'
  ) {
    warnings.push('--force flag detected: bypasses normal safeguards');
  }

  const files_touched = findTouchedPaths(args);
  const protectedHits = detectProtectedHits(files_touched);
  if (protectedHits.length > 0) {
    warnings.push(
      `touches protected path(s): ${protectedHits.slice(0, 3).join(', ')} — refusing`,
    );
  }

  const dry_run_command = deriveDryRun(base, args);
  const recommendation = recommend(base, side_effects, reversibility, warnings, protectedHits);

  return {
    parsed,
    semantic,
    side_effects,
    files_touched,
    reversibility,
    tier_required,
    ...(dry_run_command ? { dry_run_command } : {}),
    warnings,
    recommendation,
    ...(input.surface_intent ? { surface_intent: input.surface_intent } : {}),
  };
}
