import type { RequestedProviderName } from '../../core/types.js';

export type CompletionShell = 'bash' | 'zsh' | 'fish';

export type CliArgs = {
  command?: string;
  subcommand?: string;
  target?: string;
  json: boolean;
  checkOnly: boolean;
  runCommand?: string;
  stdioJson: boolean;
  tui: boolean;
  write: boolean;
  save: boolean;
  input?: string;
  session?: string;
  provider?: RequestedProviderName;
  model?: string;
  file?: string;
  out?: string;
  buildCommand?: string;
  deployCommand?: string;
  healthUrl?: string;
  testSuite?: string;
  confirmWrite: boolean;
  confirm: boolean;
  generate: boolean;
  key?: string;
  value?: string;
  name?: string;
  description?: string;
  tools?: string;
  topic?: string;
  source?: string;
  passphrase?: string;
  operatorPassphrase?: string;
  recoveryQuestion?: string;
  recoveryAnswer?: string;
  id?: string;
  query?: string;
  register?: boolean;
  to?: string;
  latest?: number;
  port?: number;
  transport?: 'stdio' | 'http';
  durationMs?: number;
  topK?: number;
  tuned?: boolean;
  strategy?: 'default' | 'latency-aware';
  interactive: boolean;
  nonInteractive: boolean;
  profile?:
    | 'dev-local'
    | 'prod-shared'
    | 'prod-decentralized'
    | 'ollama-local'
    | 'local-service'
    | 'build-only'
    | 'custom';
  force: boolean;
  /**
   * Opt-in override for `vault init`'s refuse-on-nonempty guard
   * (2026-05-13 — root-cause fix for the pepper desync that bit on
   * 2026-05-11 15:57 → 16:07). Without this flag, `vault init` refuses
   * to overwrite an existing non-empty `vault-entries.json` because
   * silent re-init regenerates the master key envelope while the old
   * ciphertext stays on disk, leaving every entry undecryptable.
   *
   * Set this flag deliberately when you really do want to wipe state
   * (after backing up `~/.memphis/`). Distinct from the generic
   * `--force` so a stray `--force` somewhere else can't accidentally
   * authorise a vault wipe.
   */
  forceReinit?: boolean;
  fix?: boolean;
  deep?: boolean;
  postInstall?: boolean;
  cron: boolean;
  apply: boolean;
  dryRun: boolean;
  skipRestart: boolean;
  skipBuild: boolean;
  allowAllUsers: boolean;
  yes: boolean;
  schema: boolean;
  verbose: boolean;
  maxTokens?: number;
  contextWindow?: number;
  temperature?: number;
  systemPrompt?: string;
  taskType?: 'chat' | 'code' | 'analysis' | 'creative';
  priority?: 'latency' | 'cost' | 'quality';
  minContext?: number;
  vision: boolean;
  functions: boolean;
  size?: 'small' | 'medium' | 'large';
  reset: boolean;
  runtime: boolean;
  chain?: string;
  cid?: string;
  recipient?: string;
  blocks?: string;
  offerId?: string;
  days?: number;
  repoPath?: string;
  agent?: string;
  list: boolean;
  clean: boolean;
  restore?: string;
  /** `memphis backup list --verify` — sweep all archives for integrity (Phase 1.2 P2 hotfix). */
  verify?: boolean;
  keep?: number;
  tag?: string;
  // `mv2` added for Sprint G N12 — `memphis export --format=mv2`. Other
  // values (`table`, `json`, `csv`) remain valid for the legacy listing
  // commands. Keep the union narrow so handlers don't have to catch
  // arbitrary strings.
  format?: 'table' | 'json' | 'csv' | 'mv2';
  include?: string;
  intervalMs?: number;
  limit?: number;
  safeMode: boolean;
  strictMode: boolean;
  noVault: boolean;
  telegram?: boolean;
  faultInject?: string;
  state?: string;
  action?: string;
  limits?: string;
  since?: string;
  until?: string;
  contains?: string;
  /**
   * Trajectory export consent filter
   * ('exportable'|'local-only'|'anonymized'|'all'). Used by
   * `memphis export trajectories`. See Y1 Q1 N9 + TRAJECTORY-EXPORT-V1.md.
   */
  consent?: string;
  status?: string;
  providerOnly: boolean;
  // Provider management
  apiKey?: string;
  // Telegram configuration
  botToken?: string;
  allowedUserIds?: string;
  // Scheduler
  cronPattern?: string;
  timezone?: string;
  // Backup restore
  pepperRestore?: string;
  // Consent mark (N11) — `consent` is shared with the trajectory export
  // flag above (both accept level strings), so only `level` + `fromIndex`
  // are new here.
  level?: string;
  fromIndex?: number;
};
