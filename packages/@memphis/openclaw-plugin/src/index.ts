import { MemphisMemoryProvider } from './MemoryProvider.js';
import type { OpenClawPluginConfig, OpenClawPluginContext } from './types.js';

let pluginContext: OpenClawPluginContext | null = null;
let provider: MemphisMemoryProvider | null = null;

export function register(context: OpenClawPluginContext): void {
  pluginContext = context;
}

export async function activate(config: OpenClawPluginConfig = {}): Promise<void> {
  if (!pluginContext) {
    throw new Error(
      'OpenClaw plugin context is not registered. Call register(context) before activate(config).',
    );
  }

  provider = new MemphisMemoryProvider(config.memphis ?? {});
  pluginContext.registerMemoryProvider('memphis', provider);
  pluginContext.logger?.info?.('Memphis OpenClaw plugin activated');
}

export async function deactivate(): Promise<void> {
  provider = null;
  pluginContext?.logger?.info?.('Memphis OpenClaw plugin deactivated');
  pluginContext = null;
}

export { MemphisClient } from './MemphisClient.js';
export { MemphisMemoryProvider } from './MemoryProvider.js';
export { SecurityManager } from './security.js';
export type {
  MemoryEntry,
  MemorySearchManager,
  MemphisPluginConfig,
  OpenClawPluginConfig,
  OpenClawPluginContext,
  SearchOptions,
  SearchResult,
} from './types.js';

export default {
  name: '@memphis/openclaw-plugin',
  version: '0.1.0',
  register,
  activate,
  deactivate,
};
