import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveInstallRoot } from '../infra/runtime/install-root.js';

const TOOL_NAME_PATTERN = /['"`](memphis_[a-z0-9_]+)['"`]/g;
// Registry values may be inline objects or imported domain-owned metadata.
// The property key remains the canonical tool name in both forms.
const REGISTRY_ENTRY_PATTERN = /^\s*(memphis_[a-z0-9_]+):/gm;
const EXECUTOR_BUILD_TOOL_PATTERN = /buildTool\(\{\s*name:\s*['"`](memphis_[a-z0-9_]+)['"`]/gs;
const MCP_REGISTER_TOOL_PATTERN = /server\.registerTool\(\s*['"`](memphis_[a-z0-9_]+)['"`]/gs;
// A tool contract entry is identified by its name; the flags that decide
// where it may run follow it in the same entry. Splitting the contract
// source at each name keeps the flags with their own tool, comments and
// all — a brace-matching pattern does not survive the explanatory comments
// that sit between the opening brace and the name.
const CONTRACT_ENTRY_SPLIT_PATTERN = /(?=\bname:\s*['"`]memphis_[a-z0-9_]+['"`])/;
const CONTRACT_ENTRY_NAME_PATTERN = /\bname:\s*['"`](memphis_[a-z0-9_]+)['"`]/;
const GATEWAY_HIDDEN_FLAG_PATTERN = /gatewayHidden:\s*true/;

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
  /**
   * Tools the native surface executes but the gateway must not advertise.
   * They stay in the registry — that is where their tier, capabilities and
   * schema live — and they are absent from the gateway surfaces on purpose.
   */
  gatewayHidden: string[];
};

type ToolSurfaceSource = {
  surface: ToolSurfaceName;
  relativePath: string;
  additionalDirectory?: string;
  extractNames: (source: string) => string[];
};

const TOOL_SURFACE_SOURCES: readonly ToolSurfaceSource[] = [
  {
    surface: 'registry',
    relativePath: 'src/gateway/tool-registry.ts',
    additionalDirectory: 'src/gateway/tool-registry',
    extractNames: (source) => extractToolNames(source, REGISTRY_ENTRY_PATTERN),
  },
  {
    surface: 'inProcessExecutor',
    relativePath: 'src/gateway/tool-executor.ts',
    additionalDirectory: 'src/gateway/tool-executor/domains',
    extractNames: (source) => extractToolNames(source, EXECUTOR_BUILD_TOOL_PATTERN),
  },
  {
    surface: 'mcpServer',
    relativePath: 'src/mcp/server.ts',
    extractNames: (source) => extractToolNames(source, MCP_REGISTER_TOOL_PATTERN),
  },
];

function extractToolNames(source: string, pattern: RegExp = TOOL_NAME_PATTERN): string[] {
  return [...new Set([...source.matchAll(pattern)].map((match) => match[1] as string))].sort(
    (a, b) => a.localeCompare(b),
  );
}

function readToolSurfaceNames(
  root: string,
  source: ToolSurfaceSource,
): { path: string; names: string[] } {
  const path = resolve(root, source.relativePath);
  const additionalContent = source.additionalDirectory
    ? readdirSync(resolve(root, source.additionalDirectory))
        .filter((entry) => entry.endsWith('.ts'))
        .sort()
        .map((entry) => readFileSync(resolve(root, source.additionalDirectory!, entry), 'utf8'))
        .join('\n')
    : '';
  const content = `${readFileSync(path, 'utf8')}\n${additionalContent}`;
  return {
    path,
    names: source.extractNames(content),
  };
}

/**
 * Tools the contract marks as gateway-hidden.
 *
 * The contract in `src/gateway/tool-contract.ts` is the single place that
 * says where a tool may run. A tool with `gatewayHidden: true` is executed
 * by the native surface only, so the gateway surfaces must NOT build it —
 * while the registry still has to carry it, because that is where its tier,
 * capabilities and schema live. Without this, the audit reports a deliberate
 * design as a missing tool.
 */
function readGatewayHiddenTools(root: string): string[] {
  const path = resolve(root, 'src/gateway/tool-contract.ts');
  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  return [
    ...new Set(
      source
        .split(CONTRACT_ENTRY_SPLIT_PATTERN)
        .filter((entry) => GATEWAY_HIDDEN_FLAG_PATTERN.test(entry))
        .map((entry) => CONTRACT_ENTRY_NAME_PATTERN.exec(entry)?.[1])
        .filter((name): name is string => Boolean(name)),
    ),
  ].sort((left, right) => left.localeCompare(right));
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
  const gatewayHidden = readGatewayHiddenTools(root);
  const gatewayHiddenSet = new Set(gatewayHidden);

  const surfaces = [...snapshots.entries()].map(([surface, snapshot]) => {
    const surfaceSet = new Set(snapshot.names);
    const isGatewaySurface = surface !== 'registry';
    return {
      surface,
      path: snapshot.path,
      names: snapshot.names,
      missingFromRegistry: snapshot.names.filter((name) => !registrySet.has(name)),
      missingFromSurface: registry.names.filter(
        (name) => !surfaceSet.has(name) && !(isGatewaySurface && gatewayHiddenSet.has(name)),
      ),
    };
  });

  // A gateway-hidden tool still has to be in the registry. That is the one
  // place its tier and capabilities are recorded, so a contract entry
  // without a registry entry is a real defect.
  const gatewayHiddenMissingFromRegistry = gatewayHidden.filter(
    (name) => !registrySet.has(name),
  );

  return {
    ok:
      surfaces.every(
        (surface) =>
          surface.missingFromRegistry.length === 0 && surface.missingFromSurface.length === 0,
      ) && gatewayHiddenMissingFromRegistry.length === 0,
    registryCount: registry.names.length,
    surfaces,
    gatewayHidden,
  };
}
