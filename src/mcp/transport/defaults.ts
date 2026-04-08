export const DEFAULT_MCP_HTTP_HOST = '127.0.0.1';
export const DEFAULT_MCP_HTTP_PORT = 3001;
export const MCP_HTTP_ENDPOINT = '/mcp';
export const MCP_HTTP_HEALTH_PATH = '/health';

export function buildMcpHttpHealthUrl(
  host = DEFAULT_MCP_HTTP_HOST,
  port = DEFAULT_MCP_HTTP_PORT,
): string {
  return `http://${host}:${port}${MCP_HTTP_HEALTH_PATH}`;
}
