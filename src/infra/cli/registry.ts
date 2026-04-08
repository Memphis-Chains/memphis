import type { CommandHandler } from './handlers/command-handler.js';

export interface CliCommandRegistration {
  readonly name: string;
  readonly commands: readonly (string | undefined)[];
  loadHandler(): Promise<CommandHandler>;
}

function createLazyHandlerLoader(
  loadModule: () => Promise<Record<string, unknown>>,
  exportName: string,
): () => Promise<CommandHandler> {
  return async () => {
    const module = await loadModule();
    return module[exportName] as CommandHandler;
  };
}

function createCommandRegistration(
  name: string,
  commands: readonly (string | undefined)[],
  loadHandler: () => Promise<CommandHandler>,
): CliCommandRegistration {
  return {
    name,
    commands,
    loadHandler,
  };
}

export const CLI_COMMAND_REGISTRY = [
  createCommandRegistration(
    'auth',
    ['auth'],
    createLazyHandlerLoader(() => import('./handlers/auth.handler.js'), 'authCommandHandler'),
  ),
  createCommandRegistration(
    'apps',
    ['apps'],
    createLazyHandlerLoader(() => import('./handlers/apps.handler.js'), 'appsCommandHandler'),
  ),
  createCommandRegistration(
    'skills',
    ['skills', 'skill'],
    createLazyHandlerLoader(() => import('./handlers/skills.handler.js'), 'skillsCommandHandler'),
  ),
  createCommandRegistration(
    'config',
    ['config'],
    createLazyHandlerLoader(() => import('./handlers/config.handler.js'), 'configCommandHandler'),
  ),
  createCommandRegistration(
    'system',
    [
      undefined,
      'help',
      '--help',
      'serve',
      'doctor',
      'providers',
      'models',
      'route',
      'ascii',
      'progress',
      'celebrate',
      'guide',
      'completion',
      'setup',
      'init',
      'configure',
      'deploy',
      'backup',
      'health',
      'workspace',
      'context',
      'service',
      'reset',
      'repair',
      'kill-zombies',
    ],
    createLazyHandlerLoader(() => import('./handlers/system.handler.js'), 'systemCommandHandler'),
  ),
  createCommandRegistration(
    'search',
    ['search'],
    createLazyHandlerLoader(() => import('./handlers/search.handler.js'), 'searchCommandHandler'),
  ),
  createCommandRegistration(
    'embed',
    ['embed'],
    createLazyHandlerLoader(() => import('./handlers/embed.handler.js'), 'embedCommandHandler'),
  ),
  createCommandRegistration(
    'vault',
    ['vault'],
    createLazyHandlerLoader(() => import('./handlers/vault.handler.js'), 'vaultCommandHandler'),
  ),
  createCommandRegistration(
    'storage',
    ['chain', 'onboarding', 'trade', 'soul'],
    createLazyHandlerLoader(() => import('./handlers/storage.handler.js'), 'storageCommandHandler'),
  ),
  createCommandRegistration(
    'decision',
    ['infer', 'decide', 'predict', 'git-stats', 'agents', 'relationships'],
    createLazyHandlerLoader(
      () => import('./handlers/decision.handler.js'),
      'decisionCommandHandler',
    ),
  ),
  createCommandRegistration(
    'knowledge',
    ['knowledge'],
    createLazyHandlerLoader(
      () => import('./handlers/knowledge.handler.js'),
      'knowledgeCommandHandler',
    ),
  ),
  createCommandRegistration(
    'worker',
    ['worker'],
    createLazyHandlerLoader(() => import('./handlers/worker.handler.js'), 'workerCommandHandler'),
  ),
  createCommandRegistration(
    'mcp',
    ['mcp'],
    createLazyHandlerLoader(() => import('./handlers/mcp.handler.js'), 'mcpCommandHandler'),
  ),
  createCommandRegistration(
    'cognitive',
    ['reflect', 'learn', 'insight', 'insights', 'connections', 'suggest', 'categorize'],
    createLazyHandlerLoader(
      () => import('./handlers/cognitive.handler.js'),
      'cognitiveCommandHandler',
    ),
  ),
  createCommandRegistration(
    'sync',
    ['sync', 'network'],
    createLazyHandlerLoader(() => import('./handlers/sync.handler.js'), 'syncCommandHandler'),
  ),
  createCommandRegistration(
    'interaction',
    ['ask', 'chat', 'ask-session', 'providers:health', 'tui'],
    createLazyHandlerLoader(
      () => import('./handlers/interaction.handler.js'),
      'interactionCommandHandler',
    ),
  ),
  createCommandRegistration(
    'trust',
    ['trust'],
    createLazyHandlerLoader(() => import('./handlers/trust.handler.js'), 'trustCommandHandler'),
  ),
  createCommandRegistration(
    'telegram',
    ['telegram'],
    createLazyHandlerLoader(() => import('./handlers/telegram.handler.js'), 'telegramCommandHandler'),
  ),
  createCommandRegistration(
    'debug',
    ['debug'],
    createLazyHandlerLoader(() => import('./handlers/debug.handler.js'), 'debugCommandHandler'),
  ),
  createCommandRegistration(
    'operator',
    ['operator'],
    createLazyHandlerLoader(() => import('./handlers/operator.handler.js'), 'operatorCommandHandler'),
  ),
  createCommandRegistration(
    'evolve',
    ['evolve'],
    createLazyHandlerLoader(() => import('./handlers/evolve.handler.js'), 'evolveCommandHandler'),
  ),
  createCommandRegistration(
    'secret',
    ['secret'],
    createLazyHandlerLoader(() => import('./handlers/secret.handler.js'), 'secretCommandHandler'),
  ),
  createCommandRegistration(
    'schedule',
    ['schedule'],
    createLazyHandlerLoader(() => import('./handlers/schedule.handler.js'), 'scheduleCommandHandler'),
  ),
  createCommandRegistration(
    'explain',
    ['explain'],
    createLazyHandlerLoader(() => import('./handlers/explain.handler.js'), 'explainCommandHandler'),
  ),
] as const;

export const CLI_COMPLETION_COMMANDS = [
  'setup',
  'init',
  'workspace',
  'context',
  'apps',
  'skills',
  'health',
  'reflect',
  'learn',
  'insight',
  'insights',
  'connections',
  'suggest',
  'knowledge',
  'serve',
  'service',
  'deploy',
  'reset',
  'worker',
  'repair',
  'providers:health',
  'providers',
  'models',
  'chat',
  'ask',
  'categorize',
  'decide',
  'infer',
  'agents',
  'relationships',
  'trust',
  'mcp',
  'debug',
  'tui',
  'doctor',
  'chain',
  'sync',
  'trade',
  'soul',
  'vault',
  'embed',
  'schedule',
  'ascii',
  'progress',
  'celebrate',
  'guide',
  'completion',
  'help',
] as const;

type CommandKey = string | undefined;

const registrationIndex: ReadonlyMap<CommandKey, readonly CliCommandRegistration[]> = (() => {
  const index = new Map<CommandKey, CliCommandRegistration[]>();
  for (const registration of CLI_COMMAND_REGISTRY) {
    for (const command of registration.commands) {
      const bucket = index.get(command);
      if (bucket) {
        bucket.push(registration);
      } else {
        index.set(command, [registration]);
      }
    }
  }
  return index;
})();

export function getCliCommandRegistrations(
  command: string | undefined,
): readonly CliCommandRegistration[] {
  return registrationIndex.get(command) ?? [];
}

export function listCliCompletionCommands(): readonly string[] {
  return CLI_COMPLETION_COMMANDS;
}
