import {
  runDeployPipeline,
  type DeployAction,
  type DeployProfile,
  type DeployResult,
  type DeployTestSuite,
} from '../../deploy/pipeline.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

const DEPLOY_ACTIONS: DeployAction[] = ['run', 'health', 'rollback'];
const DEPLOY_PROFILES: DeployProfile[] = ['local-service', 'build-only', 'custom'];
const DEPLOY_TEST_SUITES: DeployTestSuite[] = ['ts', 'rust', 'lint', 'typecheck', 'all'];

function printDeployUsage(json: boolean): void {
  print(
    {
      usage:
        'memphis deploy run|health|rollback [--profile local-service|build-only|custom] [--build-command <cmd>] [--deploy-command <cmd>] [--health-url <url>] [--test-suite ts|rust|lint|typecheck|all] [--latest <n>] [--deep] [--dry-run] [--json]',
    },
    json,
  );
}

function resolveDeployAction(value?: string): DeployAction | null {
  return DEPLOY_ACTIONS.find((action) => action === value) ?? null;
}

function resolveDeployProfile(value?: string): DeployProfile | undefined {
  if (!value) {
    return undefined;
  }
  return DEPLOY_PROFILES.find((profile) => profile === value);
}

function resolveDeployTestSuite(value?: string): DeployTestSuite | undefined {
  if (!value) {
    return undefined;
  }
  return DEPLOY_TEST_SUITES.find((suite) => suite === value);
}

function describeStep(step: NonNullable<DeployResult['test'] | DeployResult['build'] | DeployResult['deploy']>): string {
  if (step.skipped) {
    return `skipped (${step.reason ?? 'no-op'})`;
  }
  if (step.ok) {
    return `ok (${step.durationMs}ms)`;
  }
  return `failed (${step.durationMs}ms, exit=${step.exitCode ?? 'unknown'})`;
}

function printDeployHuman(result: DeployResult): void {
  console.log(`action: ${result.action}`);
  console.log(`status: ${result.success ? 'success' : 'failed'}`);
  console.log(`profile: ${result.profile}`);
  console.log(`runtime root: ${result.plan.runtimeRoot}`);
  console.log(`timestamp: ${result.timestamp}`);
  if (result.snapshotId) {
    console.log(`snapshot: ${result.snapshotId}`);
  }
  if (result.test) {
    console.log(`test: ${describeStep(result.test)}`);
  }
  if (result.build) {
    console.log(`build: ${describeStep(result.build)}`);
  }
  if (result.deploy) {
    console.log(`deploy: ${describeStep(result.deploy)}`);
  }
  if (result.health) {
    console.log(
      `health: ${result.health.ok ? 'ok' : 'failed'} (runtime=${result.health.healthStatus}, doctor=${result.health.doctorOk ? 'ok' : 'failed'})`,
    );
    if (result.health.httpChecks.length > 0) {
      for (const check of result.health.httpChecks) {
        console.log(
          `  http ${check.url}: ${check.ok ? 'ok' : 'failed'}${check.statusCode ? ` (${check.statusCode})` : ''}`,
        );
      }
    }
  }
  if (result.rollback?.attempted) {
    console.log(
      `rollback: ${result.rollback.success ? 'success' : 'failed'}${result.rollback.serviceRestarted ? ' (service restarted)' : ''}`,
    );
  }
  if (result.error) {
    console.log(`error: ${result.error}`);
  }
}

export async function handleDeployCommand(context: CliContext): Promise<boolean> {
  const { command, subcommand, json, profile, buildCommand, deployCommand, healthUrl, testSuite } =
    context.args;

  if (command !== 'deploy') {
    return false;
  }

  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printDeployUsage(json);
    return true;
  }

  const action = resolveDeployAction(subcommand);
  if (!action) {
    throw new Error(`Unknown deploy subcommand: ${subcommand}`);
  }

  const resolvedProfile = resolveDeployProfile(profile);
  if (profile && !resolvedProfile) {
    throw new Error(`Unsupported deploy profile: ${profile}`);
  }

  const resolvedTestSuite = resolveDeployTestSuite(testSuite);
  if (testSuite && !resolvedTestSuite) {
    throw new Error(`Unsupported deploy test suite: ${testSuite}`);
  }

  const result = await runDeployPipeline({
    action,
    profile: resolvedProfile,
    buildCommand,
    deployCommand,
    healthUrl,
    testSuite: resolvedTestSuite,
    deep: context.args.deep,
    dryRun: context.args.dryRun,
    rollbackIndex: context.args.latest,
  });

  if (json) {
    print(result, true);
  } else {
    printDeployHuman(result);
  }

  process.exitCode = result.success ? 0 : 1;
  return true;
}
