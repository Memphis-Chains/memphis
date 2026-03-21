import { createRequire } from 'node:module';

type BridgeModule = Record<string, unknown>;

export type BridgeAliasMap<T extends string> = Record<T, readonly [string, ...string[]]>;

export type BridgeResolution<T extends string> = {
  bridgeLoaded: boolean;
  missing: T[];
  legacyAliasesUsed: Partial<Record<T, string>>;
  resolved: Partial<Record<T, (...args: unknown[]) => unknown>>;
};

export function hasRequiredBridgeExports<T extends string>(
  resolution: BridgeResolution<T>,
  required: readonly T[],
): boolean {
  if (!resolution.bridgeLoaded) {
    return false;
  }

  return required.every((key) => typeof resolution.resolved[key] === 'function');
}

export function loadBridgeModule(path: string): BridgeModule | null {
  try {
    const req = createRequire(`${process.cwd()}/`);
    return req(path) as BridgeModule;
  } catch {
    return null;
  }
}

export function resolveBridgeContract<T extends string>(
  bridge: BridgeModule | null,
  aliases: BridgeAliasMap<T>,
): BridgeResolution<T> {
  if (!bridge) {
    return {
      bridgeLoaded: false,
      missing: Object.keys(aliases) as T[],
      legacyAliasesUsed: {},
      resolved: {},
    };
  }

  const resolved: Partial<Record<T, (...args: unknown[]) => unknown>> = {};
  const missing: T[] = [];
  const legacyAliasesUsed: Partial<Record<T, string>> = {};

  for (const key of Object.keys(aliases) as T[]) {
    const candidates = aliases[key];
    const foundAlias = candidates.find((candidate) => typeof bridge[candidate] === 'function');
    if (!foundAlias) {
      missing.push(key);
      continue;
    }

    if (foundAlias !== key) {
      legacyAliasesUsed[key] = foundAlias;
    }

    resolved[key] = bridge[foundAlias] as (...args: unknown[]) => unknown;
  }

  return {
    bridgeLoaded: true,
    missing,
    legacyAliasesUsed,
    resolved,
  };
}
