/**
 * `memphis tools` — read-only operator-facing inventory of runtime
 * capabilities. Companion to `memphis_self_describe` tool.
 *
 * Subcommands:
 *   memphis tools list                    # all available tools (human)
 *   memphis tools list --json             # all (JSON)
 *   memphis tools list --tier 0           # filter by tier
 *   memphis tools list --surface telegram # apply specific surface policy
 *   memphis tools describe <name>         # single tool detail
 *
 * Queries the daemon's `GET /v1/ops/capabilities` (auth-token gated).
 * Surfaced after a 2026-04-26 operator session where the bot was
 * hallucinating its capabilities — operators now have a CLI to verify
 * what's actually wired and exposed at any given surface.
 */

import type { CommandHandler } from './command-handler.js';
import type { CliContext } from '../context.js';

interface ToolView {
  name: string;
  tier: 0 | 1 | 2 | 3;
  capabilities: string[];
  description: string;
  featureFlag: string | null;
  available: boolean;
}

interface CapabilitiesResponse {
  surface: string;
  surfacePolicy: { maxToolTier: number };
  effectiveTier: 0 | 1 | 2 | 3;
  cognitive: { mode: string; name: string };
  tools: ToolView[];
  toolsAvailable: number;
  toolsRegistered: number;
  featureFlags: string[];
  asOf: string;
}

function parseSurfaceFlag(argv: string[]): string | undefined {
  const idx = argv.indexOf('--surface');
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  return argv[idx + 1];
}

async function fetchCapabilities(
  context: CliContext,
): Promise<CapabilitiesResponse | null> {
  const config = context.getConfig();
  // Default to the cli surface so the operator sees what *they* can run,
  // not what the daemon's default `mcp` surface would expose. Operators
  // override with `--surface telegram|tui|...` to inspect peer surfaces.
  const surface = parseSurfaceFlag(context.argv) ?? 'cli';
  const params = `?surface=${encodeURIComponent(surface)}`;
  const url = `http://${config.HOST}:${config.PORT}/v1/ops/capabilities${params}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (config.MEMPHIS_API_TOKEN) {
    headers.Authorization = `Bearer ${config.MEMPHIS_API_TOKEN}`;
  }

  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException)?.code === 'ECONNREFUSED' ||
      (error as Error)?.message?.includes('ECONNREFUSED')
    ) {
      console.error(
        'Capabilities unavailable — Memphis daemon is not running.\n' +
          'Start it with: systemctl --user start memphis (or: memphis serve)',
      );
      return null;
    }
    console.error(
      `Failed to reach daemon at ${url}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  if (response.status === 401 || response.status === 403) {
    console.error(
      `Unauthorized (${response.status}) — check MEMPHIS_API_TOKEN matches the daemon value.`,
    );
    return null;
  }

  if (!response.ok) {
    let body = '';
    try {
      body = await response.text();
    } catch {
      /* swallow */
    }
    console.error(`Daemon returned ${response.status}: ${body || '(empty body)'}`);
    return null;
  }

  try {
    return (await response.json()) as CapabilitiesResponse;
  } catch (error) {
    console.error(
      `Daemon returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

function renderListHuman(
  payload: CapabilitiesResponse,
  filter: { tier?: number },
): string {
  const lines: string[] = [];
  lines.push(
    `Surface: ${payload.surface}  ·  effective tier: ${payload.effectiveTier}  ·  ` +
      `cognitive mode: ${payload.cognitive.mode} (${payload.cognitive.name})`,
  );
  lines.push(
    `Tools: ${payload.toolsAvailable}/${payload.toolsRegistered} available  ·  ` +
      `feature flags: ${payload.featureFlags.length > 0 ? payload.featureFlags.join(', ') : '(none)'}`,
  );
  lines.push('');

  const filtered = payload.tools
    .filter((t) => (filter.tier === undefined ? true : t.tier === filter.tier))
    .sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name));

  if (filtered.length === 0) {
    lines.push('(no tools match the filter)');
    return lines.join('\n');
  }

  let currentTier: number | null = null;
  for (const t of filtered) {
    if (t.tier !== currentTier) {
      currentTier = t.tier;
      lines.push(`tier ${t.tier}:`);
    }
    const availMark = t.available ? '✓' : '✗';
    const flagMark = t.featureFlag ? ` [flag:${t.featureFlag}]` : '';
    const caps = t.capabilities.length > 0 ? t.capabilities.join(',') : '-';
    lines.push(`  ${availMark} ${t.name.padEnd(30)} ${caps.padEnd(18)}${flagMark}`);
  }
  return lines.join('\n');
}

/**
 * Pull `--tier <N>` out of context.argv. Not in CliArgs because it's a
 * tools-handler-local flag; parser.ts already passes it through verbatim.
 */
function parseTierFlag(argv: string[]): number | undefined {
  const idx = argv.indexOf('--tier');
  if (idx < 0 || idx + 1 >= argv.length) return undefined;
  const n = Number(argv[idx + 1]);
  if (n >= 0 && n <= 3 && Number.isInteger(n)) return n;
  return undefined;
}

async function handleToolsList(context: CliContext): Promise<boolean> {
  const payload = await fetchCapabilities(context);
  if (!payload) return true;

  const filter: { tier?: number } = {};
  const tierFlag = parseTierFlag(context.argv);
  if (tierFlag !== undefined) filter.tier = tierFlag;

  if (context.args.json) {
    console.log(
      JSON.stringify(
        filter.tier !== undefined
          ? { ...payload, tools: payload.tools.filter((t) => t.tier === filter.tier) }
          : payload,
        null,
        2,
      ),
    );
  } else {
    console.log(renderListHuman(payload, filter));
  }
  return true;
}

async function handleToolsDescribe(context: CliContext): Promise<boolean> {
  const target = typeof context.args.target === 'string' ? context.args.target : undefined;
  if (!target) {
    console.error('Usage: memphis tools describe <tool-name>');
    return true;
  }

  const payload = await fetchCapabilities(context);
  if (!payload) return true;

  const tool = payload.tools.find((t) => t.name === target);
  if (!tool) {
    console.error(`Tool not found in registry: ${target}`);
    console.error('Use `memphis tools list` to see all registered tools.');
    return true;
  }

  if (context.args.json) {
    console.log(JSON.stringify(tool, null, 2));
    return true;
  }

  console.log(`Tool:         ${tool.name}`);
  console.log(`Tier:         ${tool.tier}`);
  console.log(`Capabilities: ${tool.capabilities.join(', ') || '-'}`);
  console.log(`Feature flag: ${tool.featureFlag ?? '(none)'}`);
  console.log(`Available:    ${tool.available ? 'yes' : 'no'} (surface=${payload.surface})`);
  console.log('');
  console.log(tool.description);
  return true;
}

async function handleToolsCommand(context: CliContext): Promise<boolean> {
  const sub = context.args.subcommand;
  if (sub === 'list' || !sub) return handleToolsList(context);
  if (sub === 'describe') return handleToolsDescribe(context);
  console.error(`Unknown tools subcommand: ${sub}`);
  console.error('Usage: memphis tools <list|describe>');
  return true;
}

export const toolsCommandHandler: CommandHandler = {
  name: 'tools',
  commands: ['tools'],
  canHandle: (context: CliContext) => context.args.command === 'tools',
  handle: handleToolsCommand,
};
