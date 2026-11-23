import { runMemphisProviders } from '../../../mcp/tools/providers.js';
import { runMemphisSystemInfo } from '../../../mcp/tools/system-info.js';
import { runMemphisWebFetch } from '../../../mcp/tools/web-fetch.js';
import { buildRegistryInputJsonSchema } from '../../tool-json-schema.js';
import { buildTool, type RuntimeToolDefinition } from '../../tool-runtime.js';
import { optionalIntegerInRange, requiredString } from '../input-normalization.js';

export function createExternalInfoRuntimeTools(
  rawEnv?: NodeJS.ProcessEnv,
): RuntimeToolDefinition[] {
  return [
    buildTool({
      name: 'memphis_providers',
      description: 'Inspect configured providers and available models',
      inputSchema: buildRegistryInputJsonSchema('memphis_providers'),
      isConcurrencySafe: true,
      isReadOnly: true,
      async execute() {
        return runMemphisProviders();
      },
    }),
    buildTool({
      name: 'memphis_system_info',
      description: 'Inspect host and Memphis runtime system information',
      inputSchema: buildRegistryInputJsonSchema('memphis_system_info'),
      isConcurrencySafe: true,
      isReadOnly: true,
      execute() {
        return runMemphisSystemInfo();
      },
    }),
    buildTool({
      name: 'memphis_web_fetch',
      description: 'Fetch a public URL',
      inputSchema: buildRegistryInputJsonSchema('memphis_web_fetch', {
        propertyDescriptions: {
          url: 'URL to fetch',
          maxBytes: 'Max bytes of the body to return (default 32000)',
        },
      }),
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return {
          url: requiredString(args, 'url'),
          maxBytes: optionalIntegerInRange(args, 'maxBytes', 1, 32000),
        };
      },
      async execute(input) {
        return runMemphisWebFetch(input, {
          allowPrivateNetwork:
            (
              (rawEnv ?? process.env).MEMPHIS_WEB_FETCH_ALLOW_PRIVATE_NETWORK ?? ''
            ).toLowerCase() === 'true',
        });
      },
    }),
  ];
}
