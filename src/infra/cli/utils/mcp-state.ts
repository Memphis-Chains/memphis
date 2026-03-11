import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MCP_SERVE_STATE_PATH = resolve('data/mcp-serve-state.json');

export type McpServeState = { pid: number; port: number; startedAt: string; mode: 'running' };

export function writeMcpServeState(state: McpServeState): void {
  mkdirSync(resolve('data'), { recursive: true });
  writeFileSync(MCP_SERVE_STATE_PATH, JSON.stringify(state, null, 2), 'utf8');
}

export function readMcpServeState(): McpServeState | null {
  if (!existsSync(MCP_SERVE_STATE_PATH)) return null;
  return JSON.parse(readFileSync(MCP_SERVE_STATE_PATH, 'utf8')) as McpServeState;
}

export function clearMcpServeState(): void {
  if (existsSync(MCP_SERVE_STATE_PATH)) unlinkSync(MCP_SERVE_STATE_PATH);
}
