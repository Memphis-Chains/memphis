import { runMemphisProviders } from '../../../mcp/tools/providers.js';
import { runMemphisSystemInfo } from '../../../mcp/tools/system-info.js';
import { runMemphisWebFetch } from '../../../mcp/tools/web-fetch.js';
import { buildTool, type RuntimeToolDefinition } from '../../tool-runtime.js';
import { requiredString } from '../input-normalization.js';

export function createExternalInfoRuntimeTools(
  rawEnv?: NodeJS.ProcessEnv,
): RuntimeToolDefinition[] {
  return [
    buildTool({
      name: 'memphis_providers',
      description: 'Inspect configured providers and available models',
      inputSchema: { type: 'object', properties: {} },
      isConcurrencySafe: true,
      isReadOnly: true,
      async execute() {
        return runMemphisProviders();
      },
    }),
    buildTool({
      name: 'memphis_system_info',
      description: 'Inspect host and Memphis runtime system information',
      inputSchema: { type: 'object', properties: {} },
      isConcurrencySafe: true,
      isReadOnly: true,
      execute() {
        return runMemphisSystemInfo();
      },
    }),
    buildTool({
      name: 'memphis_web_fetch',
      description: 'Fetch a public URL',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'URL to fetch' } },
        required: ['url'],
      },
      isConcurrencySafe: true,
      isReadOnly: true,
      validateInput(args) {
        return { url: requiredString(args, 'url') };
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
