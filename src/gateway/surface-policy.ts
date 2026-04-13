import { getToolMeta, type ToolTier } from './tool-registry.js';

export type SurfaceClass = 'operator' | 'chat' | 'service';

export type SurfacePolicy = {
  surface: string;
  surfaceClass: SurfaceClass;
  maxToolTier: ToolTier;
  allowUnknownTools: boolean;
  allowUrlFetch: boolean;
  allowCognitivePrelude: boolean;
  allowMemoryRecall: boolean;
  allowMemoryWrite: boolean;
  allowOperatorOverride: boolean;
};

export type SurfacePolicySettingName =
  | 'maxToolTier'
  | 'allowUnknownTools'
  | 'allowUrlFetch'
  | 'allowCognitivePrelude'
  | 'allowMemoryRecall'
  | 'allowMemoryWrite'
  | 'allowOperatorOverride';

type SurfacePolicySettingDefinition = {
  name: SurfacePolicySettingName;
  envSuffix: string;
  kind: 'tier' | 'boolean';
};

export type SurfacePolicyOverride = {
  setting: SurfacePolicySettingName;
  envKey: string;
  rawValue: string;
};

export type SurfacePolicyRisk = {
  level: 'pass' | 'warn' | 'fail';
  issues: string[];
};

const DEFAULT_POLICY_OVERVIEW_SURFACES = [
  'cli.chat',
  'http.chat.generate',
  'telegram',
  'discord',
] as const;

const SURFACE_POLICY_SETTING_DEFINITIONS: readonly SurfacePolicySettingDefinition[] = [
  { name: 'maxToolTier', envSuffix: 'MAX_TOOL_TIER', kind: 'tier' },
  { name: 'allowUnknownTools', envSuffix: 'ALLOW_UNKNOWN_TOOLS', kind: 'boolean' },
  { name: 'allowUrlFetch', envSuffix: 'ALLOW_URL_FETCH', kind: 'boolean' },
  { name: 'allowCognitivePrelude', envSuffix: 'ALLOW_COGNITIVE_PRELUDE', kind: 'boolean' },
  { name: 'allowMemoryRecall', envSuffix: 'ALLOW_MEMORY_RECALL', kind: 'boolean' },
  { name: 'allowMemoryWrite', envSuffix: 'ALLOW_MEMORY_WRITE', kind: 'boolean' },
  { name: 'allowOperatorOverride', envSuffix: 'ALLOW_OPERATOR_OVERRIDE', kind: 'boolean' },
] as const;

type SurfaceDefaults = Omit<SurfacePolicy, 'surface' | 'surfaceClass'>;

const SURFACE_DEFAULTS: Record<SurfaceClass, SurfaceDefaults> = {
  operator: {
    maxToolTier: 2,
    allowUnknownTools: true,
    allowUrlFetch: true,
    allowCognitivePrelude: true,
    allowMemoryRecall: true,
    allowMemoryWrite: true,
    allowOperatorOverride: true,
  },
  chat: {
    maxToolTier: 0,
    allowUnknownTools: false,
    allowUrlFetch: false,
    allowCognitivePrelude: true,
    allowMemoryRecall: true,
    allowMemoryWrite: true,
    allowOperatorOverride: false,
  },
  service: {
    maxToolTier: 1,
    allowUnknownTools: false,
    allowUrlFetch: false,
    allowCognitivePrelude: true,
    allowMemoryRecall: true,
    allowMemoryWrite: true,
    allowOperatorOverride: false,
  },
};

const TELEGRAM_SURFACE_DEFAULTS: SurfaceDefaults = {
  ...SURFACE_DEFAULTS.chat,
  maxToolTier: 2,
  allowUrlFetch: true,
};

function normalizeSurface(surface: string): string {
  return surface.trim().toLowerCase() || 'unknown';
}

function classifySurface(surface: string): SurfaceClass {
  if (
    surface === 'terminal' ||
    surface === 'operator' ||
    surface === 'mcp' ||
    surface.startsWith('cli.') ||
    surface.startsWith('tui.') ||
    surface.startsWith('http.chat.')
  ) {
    return 'operator';
  }

  if (surface.startsWith('http.') || surface === 'http') {
    return 'service';
  }

  return 'chat';
}

function resolveSurfaceDefaults(surface: string, surfaceClass: SurfaceClass): SurfaceDefaults {
  if (surface === 'telegram') {
    return TELEGRAM_SURFACE_DEFAULTS;
  }
  return SURFACE_DEFAULTS[surfaceClass];
}

function surfaceEnvPrefix(surface: string): string {
  const slug = surface
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `MEMPHIS_SURFACE_${slug}_`;
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseToolTierEnv(value: string | undefined, fallback: ToolTier): ToolTier {
  const normalized = value?.trim();
  if (
    normalized === '0' ||
    normalized === '1' ||
    normalized === '2' ||
    normalized === '3'
  ) {
    return Number(normalized) as ToolTier;
  }
  return fallback;
}

function getSettingDefinition(
  setting: SurfacePolicySettingName,
): SurfacePolicySettingDefinition | undefined {
  return SURFACE_POLICY_SETTING_DEFINITIONS.find((item) => item.name === setting);
}

export function resolveSurfacePolicy(
  surface: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): SurfacePolicy {
  const normalizedSurface = normalizeSurface(surface);
  const surfaceClass = classifySurface(normalizedSurface);
  const defaults = resolveSurfaceDefaults(normalizedSurface, surfaceClass);
  const prefix = surfaceEnvPrefix(normalizedSurface);

  return {
    surface: normalizedSurface,
    surfaceClass,
    maxToolTier: parseToolTierEnv(rawEnv[`${prefix}MAX_TOOL_TIER`], defaults.maxToolTier),
    allowUnknownTools: parseBooleanEnv(
      rawEnv[`${prefix}ALLOW_UNKNOWN_TOOLS`],
      defaults.allowUnknownTools,
    ),
    allowUrlFetch: parseBooleanEnv(rawEnv[`${prefix}ALLOW_URL_FETCH`], defaults.allowUrlFetch),
    allowCognitivePrelude: parseBooleanEnv(
      rawEnv[`${prefix}ALLOW_COGNITIVE_PRELUDE`],
      defaults.allowCognitivePrelude,
    ),
    allowMemoryRecall: parseBooleanEnv(
      rawEnv[`${prefix}ALLOW_MEMORY_RECALL`],
      defaults.allowMemoryRecall,
    ),
    allowMemoryWrite: parseBooleanEnv(
      rawEnv[`${prefix}ALLOW_MEMORY_WRITE`],
      defaults.allowMemoryWrite,
    ),
    allowOperatorOverride: parseBooleanEnv(
      rawEnv[`${prefix}ALLOW_OPERATOR_OVERRIDE`],
      defaults.allowOperatorOverride,
    ),
  };
}

export function isToolAllowedForSurface(toolName: string, policy: SurfacePolicy): boolean {
  const meta = getToolMeta(toolName);
  if (!meta) return policy.allowUnknownTools;
  return meta.tier <= policy.maxToolTier;
}

export function getSurfacePolicySettingDefinitions(): readonly SurfacePolicySettingDefinition[] {
  return SURFACE_POLICY_SETTING_DEFINITIONS;
}

export function getSurfacePolicyEnvKey(surface: string, setting: SurfacePolicySettingName): string {
  const definition = getSettingDefinition(setting);
  if (!definition) {
    throw new Error(`Unknown surface policy setting: ${setting}`);
  }
  return `${surfaceEnvPrefix(normalizeSurface(surface))}${definition.envSuffix}`;
}

export function listSurfacePolicyOverrides(
  surface: string,
  rawEnv: NodeJS.ProcessEnv = process.env,
): SurfacePolicyOverride[] {
  return SURFACE_POLICY_SETTING_DEFINITIONS.flatMap((definition) => {
    const envKey = getSurfacePolicyEnvKey(surface, definition.name);
    const rawValue = rawEnv[envKey]?.trim();
    if (!rawValue) return [];
    return [{ setting: definition.name, envKey, rawValue }];
  });
}

export function normalizeSurfacePolicySettingName(
  value: string,
): SurfacePolicySettingName | undefined {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
  const aliases: Record<string, SurfacePolicySettingName> = {
    maxtooltier: 'maxToolTier',
    tier: 'maxToolTier',
    allowunknowntools: 'allowUnknownTools',
    allowurlfetch: 'allowUrlFetch',
    allowcognitiveprelude: 'allowCognitivePrelude',
    allowmemoryrecall: 'allowMemoryRecall',
    allowmemorywrite: 'allowMemoryWrite',
    allowoperatoroverride: 'allowOperatorOverride',
  };
  return aliases[normalized];
}

export function parseSurfacePolicySettingValue(
  setting: SurfacePolicySettingName,
  value: string,
): string {
  const definition = getSettingDefinition(setting);
  if (!definition) {
    throw new Error(`Unknown surface policy setting: ${setting}`);
  }
  const normalized = value.trim().toLowerCase();

  if (definition.kind === 'tier') {
    if (
      normalized === '0' ||
      normalized === '1' ||
      normalized === '2' ||
      normalized === '3'
    ) {
      return normalized;
    }
    throw new Error(`Invalid value for ${setting}: ${value}. Expected 0, 1, 2, or 3.`);
  }

  if (['1', 'true', 'yes', 'on'].includes(normalized)) return 'true';
  if (['0', 'false', 'no', 'off'].includes(normalized)) return 'false';
  throw new Error(`Invalid value for ${setting}: ${value}. Expected true or false.`);
}

export function evaluateSurfacePolicyRisk(policy: SurfacePolicy): SurfacePolicyRisk {
  if (policy.surfaceClass !== 'chat') {
    return { level: 'pass', issues: [] };
  }

  const hardIssues: string[] = [];
  const warnIssues: string[] = [];
  const isTelegramDefault =
    policy.surface === 'telegram' &&
    policy.maxToolTier === TELEGRAM_SURFACE_DEFAULTS.maxToolTier &&
    policy.allowUrlFetch === TELEGRAM_SURFACE_DEFAULTS.allowUrlFetch &&
    policy.allowUnknownTools === TELEGRAM_SURFACE_DEFAULTS.allowUnknownTools &&
    policy.allowOperatorOverride === TELEGRAM_SURFACE_DEFAULTS.allowOperatorOverride;

  if (policy.allowOperatorOverride) {
    hardIssues.push('operator override enabled on chat surface');
  }
  if (policy.allowUnknownTools) {
    hardIssues.push('unknown tools allowed on chat surface');
  }
  if (isTelegramDefault && hardIssues.length === 0) {
    return { level: 'pass', issues: [] };
  }
  if (policy.maxToolTier > 1 && !isTelegramDefault) {
    hardIssues.push(`max tool tier elevated to ${policy.maxToolTier}`);
  } else if (policy.maxToolTier > 0) {
    warnIssues.push(`max tool tier elevated to ${policy.maxToolTier}`);
  }
  if (policy.allowUrlFetch) {
    warnIssues.push('URL fetch enabled on chat surface');
  }

  if (hardIssues.length > 0) {
    return { level: 'fail', issues: [...hardIssues, ...warnIssues] };
  }
  if (warnIssues.length > 0) {
    return { level: 'warn', issues: warnIssues };
  }
  return { level: 'pass', issues: [] };
}

export function buildSurfacePolicySnapshot(
  rawEnv: NodeJS.ProcessEnv = process.env,
  surfaces: readonly string[] = DEFAULT_POLICY_OVERVIEW_SURFACES,
): SurfacePolicy[] {
  return surfaces.map((surface) => resolveSurfacePolicy(surface, rawEnv));
}
