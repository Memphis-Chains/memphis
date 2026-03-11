import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMemphisMcpServer } from '../server.js';

export async function serveMcpStdio(): Promise<{ close: () => Promise<void> }> {
  const server = createMemphisMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  return {
    close: async () => {
      await server.close();
    },
  };
}
