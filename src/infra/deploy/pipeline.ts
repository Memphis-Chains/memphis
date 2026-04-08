import { spawnSync } from 'node:child_process';

import type { RollbackResult, SnapshotMetadata } from '../../backup/rollback.js';
import { RollbackManager } from '../../backup/rollback.js';
import { getDataDir } from '../../config/paths.js';
import { runDoctorChecksV2, type DoctorReport } from '../cli/utils/doctor-v2.js';
import { loadConfig } from '../config/env.js';
import { buildHealthPayload, type HealthPayload } from '../http/health.js';
import {
  getUserServiceStatus,
  resolveRuntimeRoot,
  restartUserService,
  type UserServiceStatus,
} from '../runtime/user-service.js';

export type DeployAction = 'run' | 'health' | 'rollback';
export type DeployProfile = 'local-service' | 'build-only' | 'custom';
export type DeployTestSuite = 'ts' | 'rust' | 'lint' | 'typecheck' | 'all';

export interface DeployInput {
  action?: DeployAction;
  profile?: DeployProfile;
  buildCommand?: string;
  deployCommand?: string;
  healthUrl?: string;
  testSuite?: DeployTestSuite;
  deep?: boolean;
  dryRun?: boolean;
  rollbackIndex?: number;
}

export interface DeployStepResult {
  ok: boolean;
  command: string;
  output: string;
  durationMs: number;
  exitCode?: number;
  skipped?: boolean;
  reason?: string;
}

export interface DeployHttpCheck {
  url: string;
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  error?: string;
}

export interface DeployHealthReport {
  ok: boolean;
  doctorOk: boolean;
  healthStatus: HealthPayload['status'];
  requiredFailures: number;
  httpChecks: DeployHttpCheck[];
  recommendedAction: string;
  doctor: DoctorReport;
  health: HealthPayload;
  service: UserServiceStatus | null;
}

export interface DeployResult {
  success: boolean;
  action: DeployAction;
  profile: DeployProfile;
  timestamp: string;
  dryRun: boolean;
  snapshotId?: string;
  test?: DeployStepResult;
  build?: DeployStepResult;
  deploy?: DeployStepResult;
  health?: DeployHealthReport;
  rollback?: {
    attempted: boolean;
    snapshotId?: string;
    success: boolean;
    error?: string;
    serviceRestarted: boolean;
  };
  service?: UserServiceStatus | null;
  error?: string;
  plan: {
    runtimeRoot: string;
    profile: DeployProfile;
    buildCommand?: string;
    deployCommand?: string;
    healthUrls: string[];
    testSuite?: DeployTestSuite;
    deep: boolean;
  };
}

export interface DeployPipelineDeps {
  rawEnv?: NodeJS.ProcessEnv;
  runtimeRoot?: string;
  resolveRuntimeRoot?: () => string;
  runCommand?: (command: string, cwd: string, rawEnv: NodeJS.ProcessEnv) => DeployStepResult;
  getServiceStatus?: (runtimeRoot: string, rawEnv: NodeJS.ProcessEnv) => UserServiceStatus;
  restartService?: (runtimeRoot: string, rawEnv: NodeJS.ProcessEnv) => UserServiceStatus;
  createSnapshot?: (description: string) => Promise<string>;
  listSnapshots?: () => Promise<SnapshotMetadata[]>;
  rollbackSnapshot?: (snapshotId: string) => Promise<RollbackResult>;
  runDoctor?: (options: { deep: boolean }) => Promise<DoctorReport>;
  runHealth?: (rawEnv: NodeJS.ProcessEnv) => Promise<HealthPayload>;
  probeUrl?: (url: string) => Promise<DeployHttpCheck>;
}

const DEFAULT_PROFILE: DeployProfile = 'local-service';
const DEFAULT_BUILD_COMMAND = 'npm run build';
const DEFAULT_TEST_SUITE: DeployTestSuite = 'ts';
const DEFAULT_HTTP_TIMEOUT_MS = 2_500;

const TEST_SUITE_COMMANDS: Record<DeployTestSuite, string> = {
  ts: 'npx vitest run',
  rust: 'npm run test:rust',
  lint: 'npm run lint',
  typecheck: 'npm run typecheck',
  all: 'npm run test',
};

function nowIso(): string {
  return new Date().toISOString();
}

function resolveProfile(input: DeployInput): DeployProfile {
  return input.profile ?? DEFAULT_PROFILE;
}

function resolveDeployRuntimeRoot(deps: DeployPipelineDeps): string {
  if (deps.runtimeRoot) {
    return deps.runtimeRoot;
  }
  return (deps.resolveRuntimeRoot ?? (() => resolveRuntimeRoot(process.cwd())))();
}

function defaultRunCommand(
  command: string,
  cwd: string,
  rawEnv: NodeJS.ProcessEnv,
): DeployStepResult {
  const startedAt = Date.now();
  const result = spawnSync('/bin/bash', ['-lc', command], {
    cwd,
    env: { ...process.env, ...rawEnv },
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
    maxBuffer: 10 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ? `\n${result.stderr}` : ''}`.trim();
  return {
    ok: result.status === 0,
    command,
    output,
    durationMs: Date.now() - startedAt,
    exitCode: result.status ?? undefined,
  };
}

async function defaultRunDoctor(options: { deep: boolean }): Promise<DoctorReport> {
  return runDoctorChecksV2({ deep: options.deep });
}

async function defaultRunHealth(rawEnv: NodeJS.ProcessEnv): Promise<HealthPayload> {
  const config = loadConfig(rawEnv);
  return buildHealthPayload(config, rawEnv);
}

async function defaultProbeUrl(url: string): Promise<DeployHttpCheck> {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(DEFAULT_HTTP_TIMEOUT_MS),
    });
    return {
      url,
      ok: response.ok,
      statusCode: response.status,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      url,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildDefaultHealthUrl(rawEnv: NodeJS.ProcessEnv): string | null {
  try {
    const config = loadConfig(rawEnv);
    return `http://${config.HOST}:${config.PORT}/health`;
  } catch {
    return null;
  }
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.map((value) => value?.trim() ?? '').filter((value) => value.length > 0)),
  );
}

function resolveHealthUrls(
  profile: DeployProfile,
  input: DeployInput,
  rawEnv: NodeJS.ProcessEnv,
): string[] {
  return dedupeStrings([
    input.healthUrl,
    profile === 'build-only' ? null : buildDefaultHealthUrl(rawEnv),
  ]);
}

function skippedStep(command: string, reason: string): DeployStepResult {
  return {
    ok: true,
    command,
    output: '',
    durationMs: 0,
    skipped: true,
    reason,
  };
}

async function resolveHealthReport(
  input: DeployInput,
  deps: DeployPipelineDeps,
  runtimeRoot: string,
  profile: DeployProfile,
  rawEnv: NodeJS.ProcessEnv,
  requireActiveService: boolean,
): Promise<DeployHealthReport> {
  const runDoctor = deps.runDoctor ?? defaultRunDoctor;
  const runHealth = deps.runHealth ?? defaultRunHealth;
  const probeUrl = deps.probeUrl ?? defaultProbeUrl;
  const getServiceStatus = deps.getServiceStatus ?? getUserServiceStatus;

  const [doctor, health] = await Promise.all([
    runDoctor({ deep: Boolean(input.deep) }),
    runHealth(rawEnv),
  ]);

  let service: UserServiceStatus | null = null;
  try {
    service = getServiceStatus(runtimeRoot, rawEnv);
  } catch {
    service = null;
  }

  const healthUrls = resolveHealthUrls(profile, input, rawEnv);
  const httpChecks = await Promise.all(healthUrls.map((url) => probeUrl(url)));
  const httpOk = httpChecks.every((check) => check.ok);
  const serviceOk =
    !requireActiveService || !service?.installed || (Boolean(service.available) && service.active);
  const ok = doctor.ok && health.status === 'healthy' && httpOk && serviceOk;

  return {
    ok,
    doctorOk: doctor.ok,
    healthStatus: health.status,
    requiredFailures: doctor.summary.requiredFailures,
    httpChecks,
    recommendedAction: doctor.ok ? health.recommendedAction : 'Run memphis doctor --fix',
    doctor,
    health,
    service: profile === 'build-only' ? null : service,
  };
}

function buildPlan(
  input: DeployInput,
  runtimeRoot: string,
  rawEnv: NodeJS.ProcessEnv,
): DeployResult['plan'] {
  const profile = resolveProfile(input);
  return {
    runtimeRoot,
    profile,
    buildCommand: input.buildCommand?.trim() || DEFAULT_BUILD_COMMAND,
    deployCommand: input.deployCommand?.trim() || undefined,
    healthUrls: resolveHealthUrls(profile, input, rawEnv),
    testSuite: input.testSuite ?? DEFAULT_TEST_SUITE,
    deep: Boolean(input.deep),
  };
}

async function runDeploy(
  input: DeployInput,
  deps: DeployPipelineDeps,
): Promise<DeployResult> {
  const rawEnv = deps.rawEnv ?? process.env;
  const runtimeRoot = resolveDeployRuntimeRoot(deps);
  const profile = resolveProfile(input);
  const plan = buildPlan(input, runtimeRoot, rawEnv);
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const restartServiceFn = deps.restartService ?? restartUserService;
  const getServiceStatus = deps.getServiceStatus ?? getUserServiceStatus;

  if (input.dryRun) {
    return {
      success: true,
      action: 'run',
      profile,
      timestamp: nowIso(),
      dryRun: true,
      service: profile === 'build-only' ? null : tryGetServiceStatus(getServiceStatus, runtimeRoot, rawEnv),
      plan,
    };
  }

  const rollbackManager = new RollbackManager(getDataDir(rawEnv));
  const createSnapshot =
    deps.createSnapshot ?? ((description: string) => rollbackManager.createSnapshot(description));
  const rollbackSnapshot =
    deps.rollbackSnapshot ?? ((snapshotId: string) => rollbackManager.rollback(snapshotId));

  const testCommand = TEST_SUITE_COMMANDS[input.testSuite ?? DEFAULT_TEST_SUITE];
  const buildCommand = plan.buildCommand ?? DEFAULT_BUILD_COMMAND;
  const deployCommand = plan.deployCommand;
  let snapshotId: string | undefined;

  try {
    snapshotId = await createSnapshot(`deploy:${profile}`);

    const test = runCommand(testCommand, runtimeRoot, rawEnv);
    if (!test.ok) {
      throw deployFailure('test gate failed', { snapshotId, test });
    }

    const build = runCommand(buildCommand, runtimeRoot, rawEnv);
    if (!build.ok) {
      throw deployFailure('build failed', { snapshotId, test, build });
    }

    const serviceBefore = tryGetServiceStatus(getServiceStatus, runtimeRoot, rawEnv);
    let deploy: DeployStepResult;
    let serviceAfter = serviceBefore;

    if (profile === 'build-only') {
      deploy = skippedStep('build-only', 'build-only profile skips deploy step');
    } else if (deployCommand) {
      deploy = runCommand(deployCommand, runtimeRoot, rawEnv);
      if (!deploy.ok) {
        throw deployFailure('deploy command failed', {
          snapshotId,
          test,
          build,
          deploy,
          service: serviceBefore,
        });
      }
      serviceAfter = tryGetServiceStatus(getServiceStatus, runtimeRoot, rawEnv);
    } else if (profile === 'custom') {
      throw deployFailure('custom deploy profile requires deployCommand', {
        snapshotId,
        test,
        build,
        service: serviceBefore,
      });
    } else {
      if (!serviceBefore?.installed || !serviceBefore.available) {
        throw deployFailure('local-service deploy requires an installed user service', {
          snapshotId,
          test,
          build,
          service: serviceBefore,
        });
      }
      const restarted = restartServiceFn(runtimeRoot, rawEnv);
      serviceAfter = restarted;
      deploy = {
        ok: true,
        command: 'systemctl --user restart memphis.service',
        output: restarted.detail,
        durationMs: 0,
      };
    }

    const health = await resolveHealthReport(
      input,
      deps,
      runtimeRoot,
      profile,
      rawEnv,
      profile === 'local-service',
    );
    if (!health.ok) {
      throw deployFailure('post-deploy health checks failed', {
        snapshotId,
        test,
        build,
        deploy,
        service: serviceAfter,
        health,
      });
    }

    return {
      success: true,
      action: 'run',
      profile,
      timestamp: nowIso(),
      dryRun: false,
      snapshotId,
      test,
      build,
      deploy,
      health,
      service: serviceAfter,
      plan,
      rollback: {
        attempted: false,
        snapshotId,
        success: false,
        serviceRestarted: false,
      },
    };
  } catch (error) {
    const failure = toDeployFailure(error);
    const rollback: DeployResult['rollback'] = {
      attempted: false,
      snapshotId,
      success: false,
      serviceRestarted: false,
    };

    if (snapshotId) {
      rollback.attempted = true;
      const rollbackResult = await rollbackSnapshot(snapshotId);
      rollback.success = rollbackResult.success;
      rollback.error = rollbackResult.error;
      if (profile === 'local-service') {
        try {
          const serviceStatus = tryGetServiceStatus(getServiceStatus, runtimeRoot, rawEnv);
          if (serviceStatus?.installed && serviceStatus.available) {
            restartServiceFn(runtimeRoot, rawEnv);
            rollback.serviceRestarted = true;
          }
        } catch {
          rollback.serviceRestarted = false;
        }
      }
    }

    return {
      success: false,
      action: 'run',
      profile,
      timestamp: nowIso(),
      dryRun: false,
      snapshotId,
      test: failure.context.test,
      build: failure.context.build,
      deploy: failure.context.deploy,
      health: failure.context.health,
      service: failure.context.service ?? null,
      error: failure.message,
      rollback,
      plan,
    };
  }
}

async function runDeployHealth(
  input: DeployInput,
  deps: DeployPipelineDeps,
): Promise<DeployResult> {
  const rawEnv = deps.rawEnv ?? process.env;
  const runtimeRoot = resolveDeployRuntimeRoot(deps);
  const profile = resolveProfile(input);
  const health = await resolveHealthReport(input, deps, runtimeRoot, profile, rawEnv, false);

  return {
    success: health.ok,
    action: 'health',
    profile,
    timestamp: nowIso(),
    dryRun: Boolean(input.dryRun),
    health,
    service: health.service,
    plan: buildPlan(input, runtimeRoot, rawEnv),
    error: health.ok ? undefined : 'deployment health checks failed',
  };
}

async function runDeployRollback(
  input: DeployInput,
  deps: DeployPipelineDeps,
): Promise<DeployResult> {
  const rawEnv = deps.rawEnv ?? process.env;
  const runtimeRoot = resolveDeployRuntimeRoot(deps);
  const profile = resolveProfile(input);
  const rollbackManager = new RollbackManager(getDataDir(rawEnv));
  const listSnapshots = deps.listSnapshots ?? (() => rollbackManager.listSnapshots());
  const rollbackSnapshot =
    deps.rollbackSnapshot ?? ((snapshotId: string) => rollbackManager.rollback(snapshotId));
  const getServiceStatus = deps.getServiceStatus ?? getUserServiceStatus;
  const restartServiceFn = deps.restartService ?? restartUserService;
  const rollbackIndex = Math.max(1, input.rollbackIndex ?? 1);
  const snapshots = await listSnapshots();
  const snapshot = snapshots[rollbackIndex - 1];

  if (!snapshot) {
    return {
      success: false,
      action: 'rollback',
      profile,
      timestamp: nowIso(),
      dryRun: Boolean(input.dryRun),
      error: `No snapshot available at index ${rollbackIndex}`,
      plan: buildPlan(input, runtimeRoot, rawEnv),
      rollback: {
        attempted: false,
        success: false,
        serviceRestarted: false,
      },
    };
  }

  if (input.dryRun) {
    return {
      success: true,
      action: 'rollback',
      profile,
      timestamp: nowIso(),
      dryRun: true,
      snapshotId: snapshot.id,
      service: tryGetServiceStatus(getServiceStatus, runtimeRoot, rawEnv),
      plan: buildPlan(input, runtimeRoot, rawEnv),
      rollback: {
        attempted: false,
        snapshotId: snapshot.id,
        success: true,
        serviceRestarted: false,
      },
    };
  }

  const rollbackResult = await rollbackSnapshot(snapshot.id);
  let service: UserServiceStatus | null = null;
  let serviceRestarted = false;
  if (profile === 'local-service') {
    const current = tryGetServiceStatus(getServiceStatus, runtimeRoot, rawEnv);
    if (current?.installed && current.available) {
      service = restartServiceFn(runtimeRoot, rawEnv);
      serviceRestarted = true;
    } else {
      service = current;
    }
  }

  const health = rollbackResult.success
    ? await resolveHealthReport(input, deps, runtimeRoot, profile, rawEnv, false)
    : undefined;

  return {
    success: rollbackResult.success,
    action: 'rollback',
    profile,
    timestamp: nowIso(),
    dryRun: false,
    snapshotId: snapshot.id,
    health,
    service,
    error: rollbackResult.error,
    plan: buildPlan(input, runtimeRoot, rawEnv),
    rollback: {
      attempted: true,
      snapshotId: snapshot.id,
      success: rollbackResult.success,
      error: rollbackResult.error,
      serviceRestarted,
    },
  };
}

export async function runDeployPipeline(
  input: DeployInput = {},
  deps: DeployPipelineDeps = {},
): Promise<DeployResult> {
  const action = input.action ?? 'run';
  if (action === 'health') {
    return runDeployHealth(input, deps);
  }
  if (action === 'rollback') {
    return runDeployRollback(input, deps);
  }
  return runDeploy(input, deps);
}

type DeployFailureContext = {
  snapshotId?: string;
  test?: DeployStepResult;
  build?: DeployStepResult;
  deploy?: DeployStepResult;
  health?: DeployHealthReport;
  service?: UserServiceStatus | null;
};

type DeployFailure = Error & {
  context: DeployFailureContext;
};

function deployFailure(message: string, context: DeployFailureContext): DeployFailure {
  const error = new Error(message) as DeployFailure;
  error.context = context;
  return error;
}

function toDeployFailure(error: unknown): DeployFailure {
  if (error instanceof Error && 'context' in error) {
    return error as DeployFailure;
  }
  const failure = new Error(error instanceof Error ? error.message : String(error)) as DeployFailure;
  failure.context = {};
  return failure;
}

function tryGetServiceStatus(
  getServiceStatus: (runtimeRoot: string, rawEnv: NodeJS.ProcessEnv) => UserServiceStatus,
  runtimeRoot: string,
  rawEnv: NodeJS.ProcessEnv,
): UserServiceStatus | null {
  try {
    return getServiceStatus(runtimeRoot, rawEnv);
  } catch {
    return null;
  }
}
