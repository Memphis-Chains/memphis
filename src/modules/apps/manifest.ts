import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

import { getAppsPath, getDataDir } from '../../config/paths.js';
import { AppError } from '../../core/errors.js';
import { vaultDecrypt } from '../../infra/storage/rust-vault-adapter.js';
import { getLatestVaultEntry, verifyVaultEntry } from '../../infra/storage/vault-entry-store.js';

export type ManagedAppPlatform = 'linux' | 'darwin' | 'win32';
export type ManagedAppActionName = string;
const MANAGED_APP_CAPABILITY_VALUES = [
  'workspace',
  'memory',
  'browser',
  'mcp',
  'secrets',
  'service',
] as const;
export type ManagedAppCapability = (typeof MANAGED_APP_CAPABILITY_VALUES)[number];
export type ManagedAppCapabilitySummary = Record<ManagedAppCapability, number>;

type ManagedAppRuntimeCommand = {
  name: string;
  required: boolean;
  detail?: string;
};

type ManagedAppAction = {
  summary: string;
  cwd?: string;
  steps: string[];
  env: Record<string, string>;
  requiresEnv: string[];
  vaultEnv: Record<string, string>;
  vaultFiles: Record<string, { key: string; mode?: string }>;
};

export type ManagedAppManifest = {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  homepage?: string;
  capabilities: ManagedAppCapability[];
  platforms: ManagedAppPlatform[];
  runtime: {
    node?: {
      minVersion: string;
      recommendedVersion?: string;
    };
    commands: ManagedAppRuntimeCommand[];
    systemdUserService: boolean;
  };
  paths: {
    home: string;
    state: string;
    config: string;
    expose: Record<string, 'home' | 'state' | 'config'>;
  };
  actions: Record<string, ManagedAppAction>;
  notes: string[];
};

export type ManagedAppManifestSource = {
  kind: 'builtin' | 'file';
  path?: string;
};

export type ManagedAppManifestRef = {
  manifest: ManagedAppManifest;
  source: ManagedAppManifestSource;
};

export type ManagedAppRequirementStatus = {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  ok: boolean;
  required: boolean;
  detail: string;
};

export type ManagedAppResolvedPaths = {
  dataDir: string;
  manifestsDir: string;
  appsDir: string;
  appRoot: string;
  home: string;
  state: string;
  config: string;
};

export type ManagedAppPlan = {
  ok: boolean;
  supportedPlatform: boolean;
  manifest: {
    id: string;
    name: string;
    description: string;
    homepage?: string;
    capabilities: ManagedAppCapability[];
    capabilityGuidance: string[];
  };
  source: ManagedAppManifestSource;
  action: string;
  summary: string;
  applyRequested: boolean;
  willExecute: boolean;
  paths: ManagedAppResolvedPaths;
  exportedEnv: Record<string, string>;
  secretBindings: ManagedAppSecretBindingStatus[];
  cwd: string;
  steps: string[];
  requirements: ManagedAppRequirementStatus[];
  notes: string[];
};

export type ManagedAppStepResult = {
  step: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type ManagedAppExecutionResult = ManagedAppPlan & {
  executed: boolean;
  results: ManagedAppStepResult[];
};

export type ManagedAppSecretBindingStatus = {
  target: 'env' | 'file';
  envName: string;
  path?: string;
  source: 'env' | 'vault';
  vaultKey?: string;
  mode?: string;
  status: 'pass' | 'fail';
  ok: boolean;
  detail: string;
};

export type ManagedAppCatalogError = {
  path: string;
  detail: string;
};

export type ManagedAppCatalogInspection = {
  manifestsDir: string;
  manifests: ManagedAppManifestRef[];
  errors: ManagedAppCatalogError[];
  capabilityCounts: ManagedAppCapabilitySummary;
};

const MANIFEST_FILE_SUFFIX = '.json';
const MANIFEST_DIR_NAME = 'manifests';

const actionSchema = z.object({
  summary: z.string().min(1),
  cwd: z.string().min(1).optional(),
  steps: z.array(z.string().min(1)).min(1),
  env: z.record(z.string(), z.string()).optional(),
  requiresEnv: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).optional(),
  vaultEnv: z
    .record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string().regex(/^[A-Z][A-Z0-9_]*$/))
    .optional(),
  vaultFiles: z
    .record(
      z.string().min(1),
      z.union([
        z.string().regex(/^[A-Z][A-Z0-9_]*$/),
        z.object({
          key: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
          mode: z
            .string()
            .regex(/^[0-7]{3,4}$/)
            .optional(),
        }),
      ]),
    )
    .optional(),
});

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  homepage: z.string().url().optional(),
  capabilities: z.array(z.enum(MANAGED_APP_CAPABILITY_VALUES)).min(1).optional(),
  platforms: z
    .array(z.enum(['linux', 'darwin', 'win32']))
    .min(1)
    .optional(),
  runtime: z
    .object({
      node: z
        .object({
          minVersion: z.string().min(1),
          recommendedVersion: z.string().min(1).optional(),
        })
        .optional(),
      commands: z
        .array(
          z.object({
            name: z.string().regex(/^[A-Za-z0-9._-]+$/),
            required: z.boolean().optional(),
            detail: z.string().min(1).optional(),
          }),
        )
        .optional(),
      systemdUserService: z.boolean().optional(),
    })
    .optional(),
  paths: z
    .object({
      home: z.string().min(1).optional(),
      state: z.string().min(1).optional(),
      config: z.string().min(1).optional(),
      expose: z.record(z.string(), z.enum(['home', 'state', 'config'])).optional(),
    })
    .optional(),
  actions: z
    .record(z.string().min(1), actionSchema)
    .refine((value) => Object.keys(value).length > 0, {
      message: 'managed app manifest requires at least one action',
    }),
  notes: z.array(z.string().min(1)).optional(),
});

const BUILTIN_MANIFESTS: ManagedAppManifestRef[] = [];

function emptyManagedAppCapabilitySummary(): ManagedAppCapabilitySummary {
  return {
    workspace: 0,
    memory: 0,
    browser: 0,
    mcp: 0,
    secrets: 0,
    service: 0,
  };
}

function countManagedAppCapabilities(
  manifests: ManagedAppManifestRef[],
): ManagedAppCapabilitySummary {
  const counts = emptyManagedAppCapabilitySummary();
  for (const ref of manifests) {
    for (const capability of ref.manifest.capabilities) {
      counts[capability] += 1;
    }
  }
  return counts;
}

function normalizeManifest(input: unknown): ManagedAppManifest {
  const parsed = manifestSchema.parse(input);
  return {
    schemaVersion: parsed.schemaVersion,
    id: parsed.id,
    name: parsed.name,
    description: parsed.description,
    homepage: parsed.homepage,
    capabilities: [...(parsed.capabilities ?? [])].sort(),
    platforms: parsed.platforms ?? ['linux'],
    runtime: {
      node: parsed.runtime?.node,
      commands: (parsed.runtime?.commands ?? []).map((command) => ({
        name: command.name,
        required: command.required ?? true,
        detail: command.detail,
      })),
      systemdUserService: parsed.runtime?.systemdUserService ?? false,
    },
    paths: {
      home: parsed.paths?.home ?? '${APP_ROOT}/home',
      state: parsed.paths?.state ?? '${APP_ROOT}/state',
      config: parsed.paths?.config ?? '${APP_ROOT}/config/app.json',
      expose: parsed.paths?.expose ?? {},
    },
    actions: Object.fromEntries(
      Object.entries(parsed.actions).map(([name, action]) => [
        name,
        {
          summary: action.summary,
          cwd: action.cwd,
          steps: [...action.steps],
          env: action.env ?? {},
          requiresEnv: action.requiresEnv ?? [],
          vaultEnv: action.vaultEnv ?? {},
          vaultFiles: Object.fromEntries(
            Object.entries(action.vaultFiles ?? {}).map(([path, binding]) => [
              path,
              typeof binding === 'string'
                ? { key: binding }
                : { key: binding.key, mode: binding.mode },
            ]),
          ),
        },
      ]),
    ),
    notes: parsed.notes ?? [],
  };
}

function manifestsDir(rawEnv: NodeJS.ProcessEnv = process.env): string {
  return join(getAppsPath(rawEnv), MANIFEST_DIR_NAME);
}

function loadFileManifest(pathValue: string): ManagedAppManifestRef {
  const resolved = resolve(pathValue);
  const raw = readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  return {
    manifest: normalizeManifest(parsed),
    source: { kind: 'file', path: resolved },
  };
}

export function inspectManagedAppCatalog(
  rawEnv: NodeJS.ProcessEnv = process.env,
): ManagedAppCatalogInspection {
  const merged = new Map<string, ManagedAppManifestRef>();
  const errors: ManagedAppCatalogError[] = [];
  const dir = manifestsDir(rawEnv);

  for (const ref of BUILTIN_MANIFESTS) merged.set(ref.manifest.id, ref);

  if (existsSync(dir)) {
    for (const entry of readdirSync(dir)
      .filter((name) => name.endsWith(MANIFEST_FILE_SUFFIX))
      .sort((left, right) => left.localeCompare(right))) {
      const pathValue = join(dir, entry);
      try {
        const ref = loadFileManifest(pathValue);
        merged.set(ref.manifest.id, ref);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'unknown manifest parse error';
        errors.push({ path: pathValue, detail });
      }
    }
  }

  const manifests = [...merged.values()].sort((left, right) =>
    left.manifest.id.localeCompare(right.manifest.id),
  );
  return {
    manifestsDir: dir,
    manifests,
    errors,
    capabilityCounts: countManagedAppCapabilities(manifests),
  };
}

export function listManagedAppManifestRefs(
  rawEnv: NodeJS.ProcessEnv = process.env,
): ManagedAppManifestRef[] {
  return inspectManagedAppCatalog(rawEnv).manifests;
}

export function getManagedAppManifest(input: {
  id?: string;
  file?: string;
  rawEnv?: NodeJS.ProcessEnv;
}): ManagedAppManifestRef {
  if (input.file) {
    return loadFileManifest(input.file);
  }

  const id = input.id?.trim();
  if (!id) {
    throw new AppError(
      'VALIDATION_ERROR',
      'managed app requires an id or --file manifest path',
      400,
    );
  }

  const manifests = listManagedAppManifestRefs(input.rawEnv);
  const hit = manifests.find((ref) => ref.manifest.id === id);
  if (!hit) {
    throw new AppError('VALIDATION_ERROR', `managed app manifest not found: ${id}`, 404, {
      id,
      available: manifests.map((ref) => ref.manifest.id),
    });
  }
  return hit;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.').map((part) => Number(part) || 0);
  const rightParts = right.split('.').map((part) => Number(part) || 0);
  const width = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < width; index += 1) {
    const a = leftParts[index] ?? 0;
    const b = rightParts[index] ?? 0;
    if (a > b) return 1;
    if (a < b) return -1;
  }
  return 0;
}

function interpolateTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, name: string) => vars[name] ?? '');
}

export function guidanceForManagedAppCapabilities(capabilities: ManagedAppCapability[]): string[] {
  const set = new Set(capabilities);
  const guidance: string[] = [];

  if (set.has('workspace')) {
    guidance.push(
      'Workspace: initialize or sync a local project root with `memphis workspace init ./brain --json` and `memphis context sync ./brain --json`.',
    );
  }
  if (set.has('memory')) {
    guidance.push(
      'Memory: keep vector stores or indexes downstream and prefer the workspace `memory/` directory for local state.',
    );
  }
  if (set.has('browser')) {
    guidance.push(
      'Browser: keep browser adapters downstream and expose them through managed app actions instead of baking browser logic into MemphisOS core.',
    );
  }
  if (set.has('mcp')) {
    guidance.push(
      'MCP: expose a clear `status` or `doctor` action for the downstream MCP endpoint; Memphis built-in MCP health is reported separately by `memphis doctor`.',
    );
  }
  if (set.has('secrets')) {
    guidance.push(
      'Secrets: broker credentials through the Memphis vault and `vaultEnv`/`vaultFiles` bindings rather than committed env files.',
    );
  }
  if (set.has('service')) {
    guidance.push(
      'Service: prefer a supervised long-running process such as a systemd --user service and verify it through explicit lifecycle actions.',
    );
  }

  return guidance;
}

export function warningHintsForManagedAppCapabilities(
  capabilities: ManagedAppCapability[],
): string[] {
  const set = new Set(capabilities);
  const warnings: string[] = [];

  if (set.has('memory') && !set.has('workspace') && !set.has('service')) {
    warnings.push('memory tag without workspace/service scope');
  }
  if (set.has('browser') && !set.has('mcp') && !set.has('service')) {
    warnings.push('browser tag without mcp/service transport hint');
  }

  return warnings;
}

function resolveManagedAppPaths(
  manifest: ManagedAppManifest,
  rawEnv: NodeJS.ProcessEnv = process.env,
): ManagedAppResolvedPaths {
  const dataDir = getDataDir(rawEnv);
  const appsDir = getAppsPath(rawEnv);
  const appRoot = join(appsDir, manifest.id);
  const baseVars = {
    MEMPHIS_DATA_DIR: dataDir,
    MEMPHIS_APPS_DIR: appsDir,
    APP_ID: manifest.id,
    APP_ROOT: appRoot,
  };

  const home = resolve(interpolateTemplate(manifest.paths.home, baseVars));
  const state = resolve(interpolateTemplate(manifest.paths.state, baseVars));
  const config = resolve(interpolateTemplate(manifest.paths.config, baseVars));

  return {
    dataDir,
    manifestsDir: manifestsDir(rawEnv),
    appsDir,
    appRoot,
    home,
    state,
    config,
  };
}

function exportedEnvForManifest(
  manifest: ManagedAppManifest,
  paths: ManagedAppResolvedPaths,
): Record<string, string> {
  const vars: Record<string, string> = {
    MEMPHIS_DATA_DIR: paths.dataDir,
    MEMPHIS_APPS_DIR: paths.appsDir,
    APP_ID: manifest.id,
    APP_ROOT: paths.appRoot,
    APP_HOME: paths.home,
    APP_STATE_DIR: paths.state,
    APP_CONFIG_PATH: paths.config,
    MEMPHIS_MANAGED_APP: '1',
  };

  for (const [envKey, binding] of Object.entries(manifest.paths.expose)) {
    vars[envKey] =
      binding === 'home' ? paths.home : binding === 'state' ? paths.state : paths.config;
  }

  return vars;
}

function npmGlobalBin(rawEnv: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync('bash', ['-lc', 'npm prefix -g'], {
    env: { ...process.env, ...rawEnv },
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (result.status !== 0) return undefined;
  const prefix = result.stdout.trim();
  if (!prefix) return undefined;
  return join(prefix, 'bin');
}

function checkCommandAvailable(name: string, rawEnv: NodeJS.ProcessEnv): boolean {
  const result = spawnSync('bash', ['-lc', `command -v ${name}`], {
    env: { ...process.env, ...rawEnv },
    stdio: 'pipe',
    encoding: 'utf8',
  });
  return result.status === 0;
}

export function checkManagedAppRequirements(
  manifest: ManagedAppManifest,
  rawEnv: NodeJS.ProcessEnv = process.env,
): ManagedAppRequirementStatus[] {
  const currentPlatform = process.platform as ManagedAppPlatform;
  const platformOk = manifest.platforms.includes(currentPlatform);
  const statuses: ManagedAppRequirementStatus[] = [
    {
      id: 'platform',
      status: platformOk ? 'pass' : 'fail',
      ok: platformOk,
      required: true,
      detail: platformOk
        ? `platform supported: ${currentPlatform}`
        : `platform ${currentPlatform} not in supported set: ${manifest.platforms.join(', ')}`,
    },
  ];

  if (manifest.runtime.node) {
    const current = process.versions.node;
    const minOk = compareVersions(current, manifest.runtime.node.minVersion) >= 0;
    statuses.push({
      id: 'node-min-version',
      status: minOk ? 'pass' : 'fail',
      ok: minOk,
      required: true,
      detail: minOk
        ? `node ${current} satisfies minimum ${manifest.runtime.node.minVersion}`
        : `node ${current} is below minimum ${manifest.runtime.node.minVersion}`,
    });

    if (manifest.runtime.node.recommendedVersion) {
      const recommendedOk = compareVersions(current, manifest.runtime.node.recommendedVersion) >= 0;
      statuses.push({
        id: 'node-recommended-version',
        status: recommendedOk ? 'pass' : 'warn',
        ok: recommendedOk,
        required: false,
        detail: recommendedOk
          ? `node ${current} satisfies recommended ${manifest.runtime.node.recommendedVersion}`
          : `node ${current} is below recommended ${manifest.runtime.node.recommendedVersion}`,
      });
    }
  }

  for (const command of manifest.runtime.commands) {
    const ok = checkCommandAvailable(command.name, rawEnv);
    statuses.push({
      id: `command:${command.name}`,
      status: ok ? 'pass' : command.required ? 'fail' : 'warn',
      ok,
      required: command.required,
      detail: ok
        ? `${command.name} available`
        : `${command.name} missing${command.detail ? ` (${command.detail})` : ''}`,
    });
  }

  if (manifest.runtime.systemdUserService) {
    const ok = checkCommandAvailable('systemctl', rawEnv);
    statuses.push({
      id: 'systemd-user-service',
      status: ok ? 'pass' : 'fail',
      ok,
      required: true,
      detail: ok
        ? 'systemctl available for Linux user-service workflows'
        : 'systemctl missing; Linux user-service workflows will not work',
    });
  }

  return statuses;
}

function resolveAction(manifest: ManagedAppManifest, actionName: string): ManagedAppAction {
  const hit = manifest.actions[actionName];
  if (!hit) {
    throw new AppError('VALIDATION_ERROR', `managed app action not found: ${actionName}`, 404, {
      action: actionName,
      availableActions: Object.keys(manifest.actions),
    });
  }
  return hit;
}

function checkActionEnvRequirements(
  action: ManagedAppAction,
  rawEnv: NodeJS.ProcessEnv,
): ManagedAppRequirementStatus[] {
  return action.requiresEnv.map((name) => {
    const value = rawEnv[name];
    const ok = typeof value === 'string' && value.trim().length > 0;
    return {
      id: `env:${name}`,
      status: ok ? 'pass' : 'fail',
      ok,
      required: true,
      detail: ok ? `${name} configured` : `${name} is required for this action`,
    };
  });
}

function resolveActionVaultEnv(
  action: ManagedAppAction,
  rawEnv: NodeJS.ProcessEnv,
): {
  injectedEnv: Record<string, string>;
  secretBindings: ManagedAppSecretBindingStatus[];
  requirements: ManagedAppRequirementStatus[];
} {
  const entries = Object.entries(action.vaultEnv).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const injectedEnv: Record<string, string> = {};
  const secretBindings: ManagedAppSecretBindingStatus[] = [];
  const requirements: ManagedAppRequirementStatus[] = [];

  for (const [envName, vaultKey] of entries) {
    const directValue = rawEnv[envName];
    if (typeof directValue === 'string' && directValue.trim().length > 0) {
      injectedEnv[envName] = directValue;
      secretBindings.push({
        target: 'env',
        envName,
        source: 'env',
        vaultKey,
        status: 'pass',
        ok: true,
        detail: `${envName} provided directly via environment`,
      });
      requirements.push({
        id: `secret-env:${envName}`,
        status: 'pass',
        ok: true,
        required: true,
        detail: `${envName} available directly; vault key ${vaultKey} not needed for this run`,
      });
      continue;
    }

    const latest = getLatestVaultEntry(vaultKey, rawEnv);
    if (!latest) {
      secretBindings.push({
        target: 'env',
        envName,
        source: 'vault',
        vaultKey,
        status: 'fail',
        ok: false,
        detail: `${envName} missing; add vault key ${vaultKey} or export ${envName}`,
      });
      requirements.push({
        id: `secret-env:${envName}`,
        status: 'fail',
        ok: false,
        required: true,
        detail: `${envName} unavailable; no vault entry found for ${vaultKey}`,
      });
      continue;
    }

    if (!verifyVaultEntry(latest)) {
      secretBindings.push({
        target: 'env',
        envName,
        source: 'vault',
        vaultKey,
        status: 'fail',
        ok: false,
        detail: `${envName} vault entry failed fingerprint verification`,
      });
      requirements.push({
        id: `secret-env:${envName}`,
        status: 'fail',
        ok: false,
        required: true,
        detail: `${envName} unavailable; vault entry ${vaultKey} failed fingerprint verification`,
      });
      continue;
    }

    try {
      injectedEnv[envName] = vaultDecrypt(latest, rawEnv);
      secretBindings.push({
        target: 'env',
        envName,
        source: 'vault',
        vaultKey,
        status: 'pass',
        ok: true,
        detail: `${envName} resolved from vault key ${vaultKey}`,
      });
      requirements.push({
        id: `secret-env:${envName}`,
        status: 'pass',
        ok: true,
        required: true,
        detail: `${envName} resolved from vault key ${vaultKey}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'vault resolution failed';
      secretBindings.push({
        target: 'env',
        envName,
        source: 'vault',
        vaultKey,
        status: 'fail',
        ok: false,
        detail: `${envName} vault resolution failed: ${message}`,
      });
      requirements.push({
        id: `secret-env:${envName}`,
        status: 'fail',
        ok: false,
        required: true,
        detail: `${envName} unavailable; vault key ${vaultKey} failed to decrypt (${message})`,
      });
    }
  }

  return { injectedEnv, secretBindings, requirements };
}

function resolveActionVaultFiles(
  action: ManagedAppAction,
  templateVars: Record<string, string>,
  rawEnv: NodeJS.ProcessEnv,
): {
  files: Array<{ path: string; content: string; mode?: string }>;
  secretBindings: ManagedAppSecretBindingStatus[];
  requirements: ManagedAppRequirementStatus[];
} {
  const entries = Object.entries(action.vaultFiles).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const files: Array<{ path: string; content: string; mode?: string }> = [];
  const secretBindings: ManagedAppSecretBindingStatus[] = [];
  const requirements: ManagedAppRequirementStatus[] = [];

  for (const [pathTemplate, binding] of entries) {
    const filePath = resolve(interpolateTemplate(pathTemplate, templateVars));
    const latest = getLatestVaultEntry(binding.key, rawEnv);
    if (!latest) {
      secretBindings.push({
        target: 'file',
        envName: '',
        path: filePath,
        source: 'vault',
        vaultKey: binding.key,
        mode: binding.mode,
        status: 'fail',
        ok: false,
        detail: `${filePath} missing; add vault key ${binding.key}`,
      });
      requirements.push({
        id: `secret-file:${filePath}`,
        status: 'fail',
        ok: false,
        required: true,
        detail: `${filePath} unavailable; no vault entry found for ${binding.key}`,
      });
      continue;
    }

    if (!verifyVaultEntry(latest)) {
      secretBindings.push({
        target: 'file',
        envName: '',
        path: filePath,
        source: 'vault',
        vaultKey: binding.key,
        mode: binding.mode,
        status: 'fail',
        ok: false,
        detail: `${filePath} vault entry failed fingerprint verification`,
      });
      requirements.push({
        id: `secret-file:${filePath}`,
        status: 'fail',
        ok: false,
        required: true,
        detail: `${filePath} unavailable; vault entry ${binding.key} failed fingerprint verification`,
      });
      continue;
    }

    try {
      const content = vaultDecrypt(latest, rawEnv);
      files.push({ path: filePath, content, mode: binding.mode });
      secretBindings.push({
        target: 'file',
        envName: '',
        path: filePath,
        source: 'vault',
        vaultKey: binding.key,
        mode: binding.mode,
        status: 'pass',
        ok: true,
        detail: `${filePath} resolved from vault key ${binding.key}`,
      });
      requirements.push({
        id: `secret-file:${filePath}`,
        status: 'pass',
        ok: true,
        required: true,
        detail: `${filePath} resolved from vault key ${binding.key}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'vault resolution failed';
      secretBindings.push({
        target: 'file',
        envName: '',
        path: filePath,
        source: 'vault',
        vaultKey: binding.key,
        mode: binding.mode,
        status: 'fail',
        ok: false,
        detail: `${filePath} vault resolution failed: ${message}`,
      });
      requirements.push({
        id: `secret-file:${filePath}`,
        status: 'fail',
        ok: false,
        required: true,
        detail: `${filePath} unavailable; vault key ${binding.key} failed to decrypt (${message})`,
      });
    }
  }

  return { files, secretBindings, requirements };
}

export function planManagedAppAction(
  ref: ManagedAppManifestRef,
  actionName: string,
  options: { rawEnv?: NodeJS.ProcessEnv; apply?: boolean } = {},
): ManagedAppPlan {
  const rawEnv = options.rawEnv ?? process.env;
  const manifest = ref.manifest;
  const action = resolveAction(manifest, actionName);
  const paths = resolveManagedAppPaths(manifest, rawEnv);
  const exportedEnv = exportedEnvForManifest(manifest, paths);
  const templateVars = { ...exportedEnv, MEMPHIS_MANIFESTS_DIR: paths.manifestsDir };
  const secretResolution = resolveActionVaultEnv(action, rawEnv);
  const effectiveEnv = { ...rawEnv, ...secretResolution.injectedEnv };
  const secretFileResolution = resolveActionVaultFiles(action, templateVars, rawEnv);
  const cwd = resolve(interpolateTemplate(action.cwd ?? paths.home, templateVars));
  const steps = action.steps.map((step) => interpolateTemplate(step, templateVars));
  const requirements = [
    ...checkManagedAppRequirements(manifest, rawEnv),
    ...secretResolution.requirements,
    ...secretFileResolution.requirements,
    ...checkActionEnvRequirements(action, effectiveEnv),
  ];
  const ok = requirements.every((status) => !status.required || status.ok);

  return {
    ok,
    supportedPlatform: requirements.find((status) => status.id === 'platform')?.ok ?? true,
    manifest: {
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      homepage: manifest.homepage,
      capabilities: [...manifest.capabilities],
      capabilityGuidance: guidanceForManagedAppCapabilities(manifest.capabilities),
    },
    source: ref.source,
    action: actionName,
    summary: action.summary,
    applyRequested: options.apply === true,
    willExecute: options.apply === true && ok,
    paths,
    exportedEnv: {
      ...templateVars,
      ...Object.fromEntries(
        Object.entries(action.env).map(([key, value]) => [
          key,
          interpolateTemplate(value, templateVars),
        ]),
      ),
    },
    secretBindings: [...secretResolution.secretBindings, ...secretFileResolution.secretBindings],
    cwd,
    steps,
    requirements,
    notes: [...manifest.notes],
  };
}

function ensureManagedAppLayout(paths: ManagedAppResolvedPaths): void {
  mkdirSync(paths.manifestsDir, { recursive: true });
  mkdirSync(paths.appsDir, { recursive: true });
  mkdirSync(paths.appRoot, { recursive: true });
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.state, { recursive: true });
  mkdirSync(dirname(paths.config), { recursive: true });
}

function materializeSecretFiles(
  files: Array<{ path: string; content: string; mode?: string }>,
): void {
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content, 'utf8');
    try {
      chmodSync(file.path, Number.parseInt(file.mode ?? '600', 8));
    } catch {
      // best-effort permission tightening for non-POSIX hosts
    }
  }
}

export function executeManagedAppAction(
  ref: ManagedAppManifestRef,
  actionName: string,
  options: { rawEnv?: NodeJS.ProcessEnv; apply?: boolean } = {},
): ManagedAppExecutionResult {
  const plan = planManagedAppAction(ref, actionName, options);
  if (!options.apply) {
    return { ...plan, executed: false, results: [] };
  }

  if (!plan.ok) {
    const failed = plan.requirements
      .filter((status) => status.required && !status.ok)
      .map((status) => status.detail);
    throw new AppError(
      'VALIDATION_ERROR',
      `managed app action cannot run until requirements pass: ${failed.join('; ')}`,
      400,
      { action: actionName, manifestId: ref.manifest.id, failedRequirements: failed },
    );
  }

  ensureManagedAppLayout(plan.paths);

  const results: ManagedAppStepResult[] = [];
  const globalNpmBin = npmGlobalBin(options.rawEnv ?? process.env);
  const rawEnv = options.rawEnv ?? process.env;
  const secretResolution = resolveActionVaultEnv(resolveAction(ref.manifest, actionName), rawEnv);
  const templateVars = { ...plan.exportedEnv, MEMPHIS_MANIFESTS_DIR: plan.paths.manifestsDir };
  const secretFileResolution = resolveActionVaultFiles(
    resolveAction(ref.manifest, actionName),
    templateVars,
    rawEnv,
  );
  materializeSecretFiles(secretFileResolution.files);
  const mergedEnv = {
    ...process.env,
    ...rawEnv,
    ...plan.exportedEnv,
    ...secretResolution.injectedEnv,
  };
  if (globalNpmBin) {
    mergedEnv.PATH = `${globalNpmBin}:${mergedEnv.PATH ?? process.env.PATH ?? ''}`;
  }

  for (const step of plan.steps) {
    const run = spawnSync('bash', ['-lc', step], {
      cwd: plan.cwd,
      env: mergedEnv,
      stdio: 'pipe',
      encoding: 'utf8',
    });

    const result: ManagedAppStepResult = {
      step,
      cwd: plan.cwd,
      exitCode: run.status ?? 1,
      stdout: run.stdout ?? '',
      stderr: run.stderr ?? '',
    };
    results.push(result);

    if ((run.status ?? 1) !== 0) {
      throw new AppError('INTERNAL_ERROR', `managed app action failed: ${step}`, 500, {
        manifestId: ref.manifest.id,
        action: actionName,
        cwd: plan.cwd,
        exitCode: run.status ?? 1,
        stdout: run.stdout ?? '',
        stderr: run.stderr ?? '',
      });
    }
  }

  return {
    ...plan,
    executed: true,
    results,
  };
}

export type ManagedAppValidationResult =
  | { ok: true; ref: ManagedAppManifestRef }
  | { ok: false; path: string; error: string };

export function validateManagedAppManifestFile(pathValue: string): ManagedAppValidationResult {
  const resolved = resolve(pathValue);
  try {
    const ref = loadFileManifest(pathValue);
    return { ok: true, ref };
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown manifest parse error';
    return { ok: false, path: resolved, error: detail };
  }
}

export type ManagedAppImportResult = {
  ok: boolean;
  id: string;
  dest: string;
  conflict: boolean;
  overwritten: boolean;
  error?: string;
};

export function importManagedAppManifestFile(
  pathValue: string,
  options: { force?: boolean; rawEnv?: NodeJS.ProcessEnv } = {},
): ManagedAppImportResult {
  const rawEnv = options.rawEnv ?? process.env;
  const validation = validateManagedAppManifestFile(pathValue);
  if (!validation.ok) {
    return {
      ok: false,
      id: '',
      dest: '',
      conflict: false,
      overwritten: false,
      error: validation.error,
    };
  }

  const { ref } = validation;
  const dir = manifestsDir(rawEnv);
  const dest = join(dir, `${ref.manifest.id}.json`);
  const conflict = existsSync(dest);

  if (conflict && !options.force) {
    return {
      ok: false,
      id: ref.manifest.id,
      dest,
      conflict: true,
      overwritten: false,
      error: `manifest ${ref.manifest.id} already exists at ${dest}; use --force to overwrite`,
    };
  }

  // Write the original file content after validation (not the normalized form) to avoid
  // round-trip issues where normalizing optional fields like `capabilities: []` would
  // fail schema validation when the file is re-read by inspectManagedAppCatalog.
  const originalContent = readFileSync(resolve(pathValue), 'utf8');
  mkdirSync(dir, { recursive: true });
  writeFileSync(dest, originalContent, 'utf8');

  return { ok: true, id: ref.manifest.id, dest, conflict, overwritten: conflict };
}

export function describeManagedAppManifest(ref: ManagedAppManifestRef): {
  id: string;
  name: string;
  description: string;
  homepage?: string;
  source: ManagedAppManifestSource;
  capabilities: ManagedAppCapability[];
  capabilityGuidance: string[];
  capabilityWarnings: string[];
  platforms: ManagedAppPlatform[];
  actions: string[];
  notes: string[];
} {
  return {
    id: ref.manifest.id,
    name: ref.manifest.name,
    description: ref.manifest.description,
    homepage: ref.manifest.homepage,
    source: ref.source,
    capabilities: [...ref.manifest.capabilities],
    capabilityGuidance: guidanceForManagedAppCapabilities(ref.manifest.capabilities),
    capabilityWarnings: warningHintsForManagedAppCapabilities(ref.manifest.capabilities),
    platforms: [...ref.manifest.platforms],
    actions: Object.keys(ref.manifest.actions).sort(),
    notes: [...ref.manifest.notes],
  };
}
