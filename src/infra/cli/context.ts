import type { CliArgs } from './types.js';
import { createAppContainer } from '../../app/container.js';
import { loadConfig } from '../config/env.js';

type CliConfig = ReturnType<typeof loadConfig>;
type CliContainer = ReturnType<typeof createAppContainer>;

export type CliContext = {
  argv: string[];
  args: CliArgs;
  getConfig: () => CliConfig;
  getContainer: () => CliContainer;
};

export function createCliContext(argv: string[], args: CliArgs): CliContext {
  let config: CliConfig | undefined;
  let container: CliContainer | undefined;

  return {
    argv,
    args,
    getConfig: () => {
      config ??= loadConfig();
      return config;
    },
    getContainer: () => {
      container ??= createAppContainer(loadConfig());
      return container;
    },
  };
}
