/**
 * The gateway's tool schemas come from the registry — one copy, not two.
 *
 * ## Why
 *
 * A tool's contract used to exist in three places: the registry (Zod),
 * the MCP server (a JSON Schema literal) and the gateway executor (another
 * JSON Schema literal). Measured on this host before the rework: 48 of
 * the 62 MCP tools carried their own copy, and 52 of the 62 executor
 * tools carried theirs.
 *
 * Copies drift. The drift that was live:
 *   - `memphis_journal` advertised a `chain` argument on MCP and dropped
 *     it on the gateway — the same call wrote to two different chains.
 *   - 38 arguments had different constraints on the two surfaces, so the
 *     model was told one thing by the provider and another by MCP.
 *
 * ## What this gate measures
 *
 * The registry is the authority. The MCP server asks it for a shape, the
 * executor asks it for a JSON Schema. This test proves the executor half:
 *   - no executor domain may spell out an input schema literal (a source
 *     gate — a hand-written schema is a second copy the moment it is
 *     written);
 *   - every derived schema names a tool the registry knows;
 *   - the advertised property set matches the registry's shape;
 *   - `memphis_journal` keeps its `chain` argument all the way through.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createMemoryRuntimeTools } from '../../src/gateway/tool-executor/domains/memory-tools.js';
import { createInProcessToolExecutor } from '../../src/gateway/tool-executor.js';
import { TOOL_REGISTRY } from '../../src/gateway/tool-registry.js';

const DOMAIN_DIR = 'src/gateway/tool-executor/domains';

function domainFiles(): string[] {
  return readdirSync(DOMAIN_DIR)
    .filter((entry) => entry.endsWith('.ts'))
    .map((entry) => join(DOMAIN_DIR, entry));
}

function registryShapeKeys(toolName: string): string[] {
  const meta = TOOL_REGISTRY[toolName as keyof typeof TOOL_REGISTRY];
  const shape = (meta?.inputSchema as unknown as { shape?: Record<string, unknown> } | undefined)
    ?.shape;
  return shape ? Object.keys(shape) : [];
}

describe('the gateway schemas come from the registry', () => {
  it('never spells out an input schema of its own', () => {
    const offenders: string[] = [];
    for (const file of domainFiles()) {
      const source = readFileSync(file, 'utf8');
      if (source.includes('inputSchema: {')) {
        offenders.push(file);
      }
    }
    expect(
      offenders,
      'a hand-written input schema is a second copy of the registry — derive it instead',
    ).toEqual([]);
  });

  it('derives every schema from a tool the registry knows', () => {
    const unknown: string[] = [];
    for (const file of domainFiles()) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/buildRegistryInputJsonSchema\('([^']+)'/g)) {
        const toolName = match[1]!;
        if (!Object.hasOwn(TOOL_REGISTRY, toolName)) {
          unknown.push(`${file}: ${toolName}`);
        }
      }
    }
    expect(unknown, 'a derived schema for a tool the registry does not declare').toEqual([]);
  });

  it('advertises exactly the arguments the registry declares', () => {
    const mismatched: string[] = [];
    const executor = createInProcessToolExecutor({
      rawEnv: { ...process.env, MEMPHIS_FEATURES: 'experimental-tools' },
    });
    for (const tool of executor.listTools()) {
      const advertised = Object.keys(
        (tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {},
      ).sort();
      // `approval_request_id` is a transport key: the registry declares it,
      // the provider surface must not offer it.
      const declared = registryShapeKeys(tool.name)
        .filter((key) => key !== 'approval_request_id')
        .sort();
      if (advertised.join(',') !== declared.join(',')) {
        mismatched.push(`${tool.name}: [${advertised}] vs [${declared}]`);
      }
    }
    expect(mismatched, 'the gateway advertises arguments the registry does not declare').toEqual([]);
  });
});

describe('memphis_journal keeps its chain argument on every surface', () => {
  it('advertises the chain argument in the gateway schema', () => {
    const journal = createInProcessToolExecutor({
      rawEnv: { ...process.env, MEMPHIS_FEATURES: 'experimental-tools' },
    })
      .listTools()
      .find((tool) => tool.name === 'memphis_journal');

    const properties = (journal?.inputSchema as { properties?: Record<string, unknown> })
      ?.properties;
    expect(Object.keys(properties ?? {})).toContain('chain');
  });

  it('carries the chain through the gateway input normalization', () => {
    // The gateway used to drop it here: the model asked for a chain, the
    // provider path wrote to the default one, and the MCP path wrote to
    // the requested one. The same call, two destinations.
    const tool = createMemoryRuntimeTools({}).find((entry) => entry.name === 'memphis_journal');
    const normalized = tool?.validateInput?.({
      content: 'a note',
      tags: ['test'],
      chain: 'decisions',
    }) as { chain?: string } | undefined;

    expect(normalized?.chain).toBe('decisions');
  });
});
