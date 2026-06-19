import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveInstallRoot } from '../infra/runtime/install-root.js';

const TOOL_NAME_PATTERN = /['"`](memphis_[a-z0-9_]+)['"`]/g;
const REGISTRY_ENTRY_PATTERN = /^\s*(memphis_[a-z0-9_]+):\s*\{/gm;
const EXECUTOR_BUILD_TOOL_PATTERN =
  /buildTool\(\{\s*name:\s*['"`](memphis_[a-z0-9_]+)['"`]/gs;
const MCP_REGISTER_TOOL_PATTERN =
  /server\.registerTool\(\s*['"`](memphis_[a-z0-9_]+)['"`]/gs;

export type ToolSurfaceName = 'registry' | 'inProcessExecutor' | 'mcpServer';

export type ToolSurfaceAuditSurface = {
  surface: ToolSurfaceName;
  path: string;
  names: string[];
  missingFromRegistry: string[];
  missingFromSurface: string[];
};

export type ToolSurfaceAuditReport = {
  ok: boolean;
  registryCount: number;
  surfaces: ToolSurfaceAuditSurface[];
};

type ToolSurfaceSource = {
  surface: ToolSurfaceName;
  relativePath: string;
  extractNames: (source: string) => string[];
};

const TOOL_SURFACE_SOURCES: readonly ToolSurfaceSource[] = [
  {
    surface: 'registry',
    relativePath: 'src/gateway/tool-registry.ts',
    extractNames: (source) => extractToolNames(source, REGISTRY_ENTRY_PATTERN),
  },
  {
    surface: 'inProcessExecutor',
    relativePath: 'src/gateway/tool-executor.ts',
    extractNames: (source) => extractToolNames(source, EXECUTOR_BUILD_TOOL_PATTERN),
  },
  {
    surface: 'mcpServer',
    relativePath: 'src/mcp/server.ts',
    extractNames: (source) => extractToolNames(source, MCP_REGISTER_TOOL_PATTERN),
  },
];

function extractToolNames(source: string, pattern: RegExp = TOOL_NAME_PATTERN): string[] {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1] as string))]
    .sort((a, b) => a.localeCompare(b));
}

function readToolSurfaceNames(
  root: string,
  source: ToolSurfaceSource,
): { path: string; names: string[] } {
  const path = resolve(root, source.relativePath);
  const content = readFileSync(path, 'utf8');
  return {
    path,
    names: source.extractNames(content),
  };
}

export function buildToolSurfaceAuditReport(
  rawEnv: NodeJS.ProcessEnv = process.env,
): ToolSurfaceAuditReport {
  const root = resolveInstallRoot({ rawEnv });
  const snapshots = new Map<ToolSurfaceName, { path: string; names: string[] }>();

  for (const source of TOOL_SURFACE_SOURCES) {
    snapshots.set(source.surface, readToolSurfaceNames(root, source));
  }

  const registry = snapshots.get('registry');
  if (!registry) {
    throw new Error('tool registry source missing from audit snapshot');
  }
  const registrySet = new Set(registry.names);

  const surfaces = [...snapshots.entries()].map(([surface, snapshot]) => {
    const surfaceSet = new Set(snapshot.names);
    return {
      surface,
      path: snapshot.path,
      names: snapshot.names,
      missingFromRegistry: snapshot.names.filter((name) => !registrySet.has(name)),
      missingFromSurface: registry.names.filter((name) => !surfaceSet.has(name)),
    };
  });

  return {
    ok: surfaces.every(
      (surface) =>
        surface.missingFromRegistry.length === 0 && surface.missingFromSurface.length === 0,
    ),
    registryCount: registry.names.length,
    surfaces,
  };
}
