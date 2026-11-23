/**
 * The native tool contract — the TypeScript side of the bridge check.
 *
 * ## Why
 *
 * The registry (`src/gateway/tool-registry.ts`) is the authority on what a
 * tool accepts. The native cockpit advertised its own copy of that
 * contract, hand-written in Rust, and nothing compared the two.
 *
 * Measured 2026-11-22 on this host: five of the 23 native tools
 * advertised DIFFERENT ARGUMENTS from the registry. `memphis_self_modify`
 * under one name meant "write one file" and under the other "apply
 * changes to many files". A model talking to the cockpit and a model
 * talking to Telegram, the CLI or MCP were offered different tools under
 * the same names.
 *
 * ## What this test measures
 *
 * The artifact `tests/fixtures/native-tool-contract.json` is the agreed
 * contract. The Rust side checks itself against it
 * (`crates/memphis-operator/src/chat_tool_catalog.rs`), and this test
 * checks the registry against it. Neither side produces it alone, so
 * neither side can quietly change it.
 *
 * The artifact also carries the DECLARED DIVERGENCES: the tools whose
 * native implementation does not honour the registry. They are named with
 * the reason and with the work that closes them, so the gap is visible
 * rather than hidden behind a schema that promises what the cockpit
 * cannot do.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { nativeToolContractNames } from '../../src/gateway/tool-contract.js';
import { buildRegistryInputJsonSchema } from '../../src/gateway/tool-json-schema.js';

const FIXTURE = resolve('tests/fixtures/native-tool-contract.json');

type ToolContract = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

type ContractDocument = {
  schemaVersion: number;
  tools: ToolContract[];
  divergences: Array<{ name: string; reason: string; closure: string }>;
};

function contractDocument(): ContractDocument {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as ContractDocument;
}

describe('the native tool contract', () => {
  it('covers every native tool exactly once', () => {
    const document = contractDocument();
    const projected = document.tools.map((tool) => tool.name);
    const divergent = document.divergences.map((entry) => entry.name);
    const native = nativeToolContractNames();

    expect(projected.length + divergent.length).toBe(native.length);
    expect([...projected, ...divergent].sort()).toEqual([...native].sort());
    // No tool is projected and divergent at the same time.
    expect(projected.filter((name) => divergent.includes(name))).toEqual([]);
  });

  it('carries the registry\'s own schema for every projected tool', () => {
    const document = contractDocument();
    const problems: string[] = [];

    for (const tool of document.tools) {
      // The provider surface's renderer — the same one the gateway uses.
      const expected = buildRegistryInputJsonSchema(tool.name) as Record<string, unknown>;
      const expectedProperties = (expected.properties ?? {}) as Record<string, unknown>;
      const actualProperties = (tool.input_schema.properties ?? {}) as Record<string, unknown>;

      for (const key of Object.keys(expectedProperties)) {
        if (!(key in actualProperties)) {
          problems.push(`${tool.name}: the registry declares ${key} — the contract does not`);
          continue;
        }
        const expectedProperty = expectedProperties[key] as Record<string, unknown>;
        const actualProperty = actualProperties[key] as Record<string, unknown>;
        for (const constraint of ['type', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength']) {
          if (!(constraint in expectedProperty)) continue;
          // An enum is an ARRAY: two renderings of the same enum are
          // different objects with the same content, so the comparison
          // has to be by content, not by identity.
          const same = JSON.stringify(expectedProperty[constraint]) === JSON.stringify(actualProperty[constraint]);
          if (!same) {
            problems.push(
              `${tool.name}.${key}: the registry says ${constraint}=${JSON.stringify(
                expectedProperty[constraint],
              )}, the contract says ${JSON.stringify(actualProperty[constraint])}`,
            );
          }
        }
      }

      const expectedRequired = (expected.required ?? []) as string[];
      const actualRequired = (tool.input_schema.required ?? []) as string[];
      if ([...expectedRequired].sort().join(',') !== [...actualRequired].sort().join(',')) {
        problems.push(
          `${tool.name}: required=[${actualRequired}] in the contract, [${expectedRequired}] in the registry`,
        );
      }
    }

    expect(problems, 'the contract must carry the registry\'s own schema').toEqual([]);
  });

  it('declares every divergence with a reason and a way to close it', () => {
    const document = contractDocument();
    for (const divergence of document.divergences) {
      expect(divergence.reason.length).toBeGreaterThan(20);
      expect(divergence.closure.length).toBeGreaterThan(20);
      // A divergence is a gap, not an excuse: it must name the tool the
      // registry declares the same name for.
      expect(Object.hasOwn(TOOL_REGISTRY_NAMES, divergence.name)).toBe(true);
    }
  });
});

/** The registry's tool names, read once. */
const TOOL_REGISTRY_NAMES: Record<string, true> = (() => {
  const names: Record<string, true> = {};
  for (const name of nativeToolContractNames()) names[name] = true;
  return names;
})();
