import type { RequestedProviderName } from '../../core/types.js';

export type CompletionShell = 'bash' | 'zsh' | 'fish';

// CLI argument types for setup matrix command
export type MatrixSetupArgs = {
  serverName?: string;
  adminUser?: string;
  adminPass?: string;
};

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
  fix?: boolean;
  deep?: boolean;
  cron: boolean;
  apply: boolean;
  dryRun: boolean;
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
  keep?: number;
  tag?: string;
  format?: 'table' | 'json' | 'csv';
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
  providerOnly: boolean;
  // Matrix setup
  serverName?: string;
  adminUser?: string;
  adminPass?: string;
  // Provider management
  apiKey?: string;
  // Telegram configuration
  botToken?: string;
  allowedUserIds?: string;
  // Scheduler
  cronPattern?: string;
};
