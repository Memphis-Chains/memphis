import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { TOOL_REGISTRY } from '../../src/gateway/tool-registry.js';
import { createMemphisMcpServer } from '../../src/mcp/server.js';

/**
 * The MCP surface must be the registry's surface.
 *
 * ## Why
 *
 * The MCP server used to carry a SECOND copy of the input schema for 48
 * of its 62 tools. The registry is the one place a tool's contract
 * lives — the gateway executor, the provider surface and the CLI all
 * read it — so the MCP copy was a second rule with a second place to
 * forget.
 *
 * It had already drifted. Measured 2026-11-22: `memphis_journal`
 * advertised a `chain` argument that the registry's `.strict()` schema
 * rejected, so the same call succeeded over MCP and failed through the
 * gateway. The registry's `memphis_exec` had no length bound on the
 * command it accepted.
 *
 * ## What this gate measures
 *
 * It asks the server what a real MCP client sees — the tool list over
 * the in-memory transport — and compares every advertised input schema
 * with the schema the registry declares for the same tool. A tool that
 * drifts, or a tool the registry forgot, fails here instead of at a
 * client.
 *
 * The comparison is on the JSON Schema the client receives, because that
 * is what a client acts on. Both sides are rendered by the same renderer,
 * with the same options the MCP SDK uses (`draft-7`, `input` mode), so
 * the comparison is exact: a difference here is a real difference in the
 * contract, not an artefact of two converters disagreeing.
 *
 * The `input` mode is the one that matters. A field with a default is
 * optional to a client, so it must not appear in `required` — and it does
 * not, in either rendering. The earlier comparison failed on
 * `memphis_lr_dashboard` precisely because one side was rendered in
 * `output` mode, where a defaulted field reads as always present.
 */
function normalizeSchema(schema: unknown): string {
  const clone = JSON.parse(JSON.stringify(schema ?? {})) as Record<string, unknown>;
  // The `$schema` key names the meta-schema draft, not the contract.
  delete clone.$schema;
  return canonicalJson(clone);
}

/**
 * A stable rendering of a JSON value: keys sorted, recursively.
 *
 * `JSON.stringify(value, keys)` is NOT a key sorter — the second argument
 * is a whitelist of property names to EMIT, at every level. Using it as
 * one silently dropped every tool argument from the comparison, which
 * made the gate pass on a schema that had drifted. Sorting the keys of
 * the object is the only way to compare two renderings.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The registry's schema, rendered the way a client renders it.
 *
 * The SDK converts a tool's input shape with
 * `toJSONSchema(object, { target: 'draft-7', io: 'input' })`. Measured on
 * this host: the repo's own `zod` and the SDK's `zod/v4-mini` produce
 * byte-identical output for all 64 registry entries, so the gate uses the
 * repo's dependency and stays honest about the SDK's internals.
 */
function registryJsonSchema(toolName: string): unknown {
  const schema = TOOL_REGISTRY[toolName]?.inputSchema;
  if (!schema) return null;
  const shape = (schema as { shape?: unknown }).shape;
  if (!shape || typeof shape !== 'object') return null;
  return z.toJSONSchema(z.object(shape as Record<string, z.ZodType>), {
    target: 'draft-7',
    io: 'input',
  });
}

describe('the MCP surface is the registry surface', () => {
  it('advertises exactly the tools the registry declares', async () => {
    const server = createMemphisMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'schema-parity', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const listed = await client.listTools();
      const advertised = new Map(listed.tools.map((tool) => [tool.name, tool]));

      // Tools the native surface runs and the gateway must not advertise
      // are deliberately absent — `gatewayHidden` in the tool contract.
      const gatewayHidden = new Set(
        (await import('../../src/gateway/tool-contract.js')).NATIVE_TOOL_CONTRACTS.filter(
          (contract) => contract.gatewayHidden,
        ).map((contract) => contract.name),
      );

      // A tool behind a feature flag that is OFF is deliberately absent
      // too. A tool behind a flag that is ON must be present — otherwise
      // the flag promises something the server does not deliver.
      const { isFeatureFlagEnabled } = await import('../../src/infra/features/flags.js');
      const expectedAbsent = Object.keys(TOOL_REGISTRY).filter(
        (name) =>
          gatewayHidden.has(name) ||
          (TOOL_REGISTRY[name]!.featureFlag !== undefined &&
            !isFeatureFlagEnabled(TOOL_REGISTRY[name]!.featureFlag!, process.env)),
      );

      const missing = Object.keys(TOOL_REGISTRY)
        .filter((name) => !expectedAbsent.includes(name))
        .filter((name) => !advertised.has(name));
      expect(missing, 'tools the registry declares but the MCP server does not offer').toEqual([]);

      const unknown = [...advertised.keys()].filter((name) => !TOOL_REGISTRY[name]);
      expect(unknown, 'tools the MCP server offers that the registry does not declare').toEqual([]);

      const mismatched: string[] = [];
      for (const [name, tool] of advertised) {
        const expected = registryJsonSchema(name);
        if (!expected) continue;
        if (normalizeSchema(expected) !== normalizeSchema(tool.inputSchema)) {
          mismatched.push(name);
        }
      }
      expect(mismatched, 'tools whose advertised input schema differs from the registry').toEqual(
        [],
      );
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('offers every tool the registry declares once the flags are on', async () => {
    // The flag is a promise: if a tool says "experimental-tools", turning
    // that flag on must actually make it reachable. Otherwise the flag
    // is decoration and the tool is unreachable forever.
    const rawEnv: NodeJS.ProcessEnv = { ...process.env, MEMPHIS_FEATURES: 'experimental-tools' };
    const server = createMemphisMcpServer(undefined, rawEnv);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'schema-parity-flags', version: '1.0.0' });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    try {
      const listed = await client.listTools();
      const advertised = new Set(listed.tools.map((tool) => tool.name));

      const { NATIVE_TOOL_CONTRACTS } = await import('../../src/gateway/tool-contract.js');
      const gatewayHidden = new Set(
        NATIVE_TOOL_CONTRACTS.filter((contract) => contract.gatewayHidden).map(
          (contract) => contract.name,
        ),
      );

      const missing = Object.keys(TOOL_REGISTRY)
        .filter((name) => !gatewayHidden.has(name))
        .filter((name) => !advertised.has(name));
      expect(
        missing,
        'tools the registry declares that stay unreachable even with the flags on',
      ).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
