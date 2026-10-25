/**
 * Contract tests for the shared tool contract.
 *
 * The contract in `src/gateway/tool-contract.ts` is meant to be the single
 * place that says which tools the native Rust operator can execute, what
 * tier they need and what they can do. These tests prove that it is, by
 * checking it against the three places it must agree with:
 *
 *   1. the Rust catalog — the tools advertised to the model
 *   2. the Rust dispatcher — the tools that actually run
 *   3. `TOOL_REGISTRY` — the TypeScript side's policy table
 *
 * The Rust side is read from source because the contract test runs in
 * TypeScript and the Rust binary is not built for it. The Rust side has
 * its own generator check (`npm run -s ops:sync-native-tiers -- --check`),
 * and the two together close the loop: this test proves the contract
 * matches the Rust source, and the generator proves the Rust tier table
 * matches the contract.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { nativeToolPolicy, requireToolPolicy } from '../../src/gateway/native-tool-policy.js';
import {
  NATIVE_TOOL_CONTRACTS,
  getToolContract,
  nativeToolContractNames,
  requireToolContract,
} from '../../src/gateway/tool-contract.js';
import { TOOL_REGISTRY } from '../../src/gateway/tool-registry.js';

const RUST_CATALOG = resolve('crates/memphis-operator/src/chat_tool_catalog.rs');
const RUST_EXECUTOR = resolve('crates/memphis-operator/src/chat_tool_executor.rs');

function rustAdvertisedTools(): string[] {
  const source = readFileSync(RUST_CATALOG, 'utf8');
  const catalog = source.split('fn native_tool_definitions()')[1]?.split('fn tool_tier(')[0];
  expect(catalog, 'Rust catalog boundary not found').toBeDefined();
  return [...(catalog as string).matchAll(/name: "(memphis_[a-z0-9_]+)"/g)].map((m) => m[1]);
}

function rustExecutableTools(): string[] {
  const source = readFileSync(RUST_EXECUTOR, 'utf8');
  const executor = source.split('fn execute_native_tool(')[1];
  expect(executor, 'Rust executor boundary not found').toBeDefined();
  return [...(executor as string).matchAll(/^ {8}"(memphis_[a-z0-9_]+)" =>/gm)].map((m) => m[1]);
}

describe('shared tool contract', () => {
  it('describes exactly the tools the native catalog advertises', () => {
    expect([...nativeToolContractNames()].sort()).toEqual([...rustAdvertisedTools()].sort());
  });

  it('describes exactly the tools the native dispatcher executes', () => {
    expect([...nativeToolContractNames()].sort()).toEqual([...rustExecutableTools()].sort());
  });

  it('agrees with TOOL_REGISTRY on the tier of every gateway-visible tool', () => {
    for (const contract of NATIVE_TOOL_CONTRACTS) {
      const registryMeta = TOOL_REGISTRY[contract.name];
      if (!registryMeta) {
        // Native-only tools must say so explicitly, otherwise a missing
        // registry entry is indistinguishable from an oversight.
        expect(
          contract.gatewayHidden,
          `${contract.name} is absent from TOOL_REGISTRY but not marked gatewayHidden`,
        ).toBe(true);
        continue;
      }
      expect(registryMeta.tier, `tier drift for ${contract.name}`).toBe(contract.tier);
    }
  });

  it('agrees with TOOL_REGISTRY on the capabilities of every gateway-visible tool', () => {
    for (const contract of NATIVE_TOOL_CONTRACTS) {
      const registryMeta = TOOL_REGISTRY[contract.name];
      if (!registryMeta) continue;
      expect(
        [...registryMeta.capabilities].sort(),
        `capability drift for ${contract.name}`,
      ).toEqual([...contract.capabilities].sort());
    }
  });

  it('has no duplicate tool names', () => {
    const names = NATIVE_TOOL_CONTRACTS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('exposes every contract tool with a valid tier and non-empty capabilities', () => {
    for (const contract of NATIVE_TOOL_CONTRACTS) {
      expect(Number.isInteger(contract.tier)).toBe(true);
      expect(contract.tier).toBeGreaterThanOrEqual(0);
      expect(contract.tier).toBeLessThanOrEqual(3);
      expect(contract.capabilities.length).toBeGreaterThan(0);
      expect(contract.exposures.length).toBeGreaterThan(0);
    }
  });

  it('resolves a contract by name and rejects an unknown tool', () => {
    expect(getToolContract('memphis_journal')?.name).toBe('memphis_journal');
    expect(getToolContract('memphis_not_a_tool')).toBeUndefined();
    expect(() => requireToolContract('memphis_not_a_tool')).toThrow(/Missing/);
  });

  it('serves a native-only tool from the contract', () => {
    // memphis_vault_list is executable natively and the gateway does not
    // advertise it. Before the contract existed it was absent from
    // TOOL_REGISTRY entirely and carried a hand-written tier in
    // native-tool-policy.ts, so no registry-driven check could see it.
    //
    // It is now listed in the registry (so the tier and capabilities have
    // one home) and marked gatewayHidden in the contract.
    const contract = requireToolContract('memphis_vault_list');
    expect(contract.gatewayHidden).toBe(true);
    expect(contract.exposures).toEqual(['native']);

    const policy = nativeToolPolicy('memphis_vault_list');
    expect(policy.tier).toBe(0);
    expect(policy.capabilities).toEqual(['read']);
  });

  it('resolves a native-only tool from the contract even if the registry drops it', () => {
    // The contract is the fallback: a tool that the gateway stops listing
    // still has one policy home, so the native surface keeps a defined
    // tier instead of falling back to an implicit default.
    const registryWithoutIt = { ...TOOL_REGISTRY };
    delete registryWithoutIt['memphis_vault_list'];
    const policy = requireToolPolicy('memphis_vault_list', registryWithoutIt);
    expect(policy.tier).toBe(0);
    expect(policy.capabilities).toEqual(['read']);
  });

  it('keeps the registry metadata for tools that have it', () => {
    const policy = requireToolPolicy('memphis_journal', TOOL_REGISTRY);
    expect(policy.tier).toBe(0);
    expect(policy.description).toBe(TOOL_REGISTRY['memphis_journal'].description);
  });

  it('refuses an unclassified executable operation', () => {
    expect(() => requireToolPolicy('memphis_unclassified', TOOL_REGISTRY)).toThrow(/Missing/);
  });
});
