import chalk from 'chalk';

import {
  describeManagedAppManifest,
  executeManagedAppAction,
  getManagedAppManifest,
  importManagedAppManifestFile,
  inspectManagedAppCatalog,
  planManagedAppAction,
  validateManagedAppManifestFile,
} from '../../../modules/apps/manifest.js';
import {
  getManagedAppRegistryRecord,
  loadManagedAppRegistry,
  recordManagedAppExecution,
} from '../../../modules/apps/registry.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

function printAppsHelp(json: boolean): void {
  print(
    {
      usage:
        'memphis apps list|show <id>|plan <id> [--action <name>] | run <id> --action <name> [--dry-run|--apply] [--file <manifest.json>] | validate [--file <manifest.json>] | import --file <manifest.json> [--force] [--json]',
      notes:
        'Lifecycle aliases: install|start|stop|restart|status|doctor|dashboard <id> [--dry-run|--apply] [--file <manifest.json>] ; actions may resolve vault-backed env/file bindings via manifest vaultEnv and vaultFiles entries',
    },
    json,
  );
}

function manifestRefFromContext(context: CliContext) {
  return getManagedAppManifest({
    id: context.args.target,
    file: context.args.file,
    rawEnv: process.env,
  });
}

function actionNameFromContext(context: CliContext): string {
  const { subcommand, action } = context.args;
  if (!subcommand) return action ?? 'install';
  if (subcommand === 'plan' || subcommand === 'run') return action ?? 'install';
  return subcommand;
}

function printCapabilityGuidanceHuman(guidance: string[], indent = ''): void {
  if (guidance.length === 0) return;
  console.log(`${indent}guidance:`);
  for (const item of guidance) {
    console.log(`${indent}  - ${item}`);
  }
}

function printCapabilityWarningsHuman(warnings: string[], indent = ''): void {
  if (warnings.length === 0) return;
  console.log(`${indent}warnings:`);
  for (const item of warnings) {
    console.log(`${indent}  - ${item}`);
  }
}

function printManifestHuman(ref: ReturnType<typeof manifestRefFromContext>): void {
  const summary = describeManagedAppManifest(ref);
  const record = getManagedAppRegistryRecord(summary.id, process.env);
  console.log(chalk.cyan(`${summary.name} (${summary.id})`));
  console.log(summary.description);
  console.log(
    `source: ${summary.source.kind}${summary.source.path ? ` (${summary.source.path})` : ''}`,
  );
  if (summary.capabilities.length > 0) {
    console.log(`capabilities: ${summary.capabilities.join(', ')}`);
  }
  console.log(`platforms: ${summary.platforms.join(', ')}`);
  console.log(`actions: ${summary.actions.join(', ')}`);
  if (summary.homepage) console.log(`homepage: ${summary.homepage}`);
  if (record) {
    console.log(`installed: ${record.installed}`);
    console.log(`state: ${record.state}`);
    console.log(`lastAction: ${record.lastAction} @ ${record.lastActionAt}`);
  }
  printCapabilityWarningsHuman(summary.capabilityWarnings);
  printCapabilityGuidanceHuman(summary.capabilityGuidance);
  for (const note of summary.notes) {
    console.log(`note: ${note}`);
  }
}

function printPlanHuman(
  plan: ReturnType<typeof planManagedAppAction> | ReturnType<typeof executeManagedAppAction>,
): void {
  console.log(chalk.cyan(`${plan.manifest.name} :: ${plan.action}`));
  console.log(plan.summary);
  console.log(`applyRequested: ${plan.applyRequested}`);
  console.log(`willExecute: ${plan.willExecute}`);
  console.log(`source: ${plan.source.kind}${plan.source.path ? ` (${plan.source.path})` : ''}`);
  if (plan.manifest.capabilities.length > 0) {
    console.log(`capabilities: ${plan.manifest.capabilities.join(', ')}`);
  }
  printCapabilityGuidanceHuman(plan.manifest.capabilityGuidance);
  console.log(`cwd: ${plan.cwd}`);
  console.log('paths:');
  console.log(`  appRoot: ${plan.paths.appRoot}`);
  console.log(`  home: ${plan.paths.home}`);
  console.log(`  state: ${plan.paths.state}`);
  console.log(`  config: ${plan.paths.config}`);
  console.log('requirements:');
  for (const status of plan.requirements) {
    const color =
      status.status === 'pass' ? chalk.green : status.status === 'warn' ? chalk.yellow : chalk.red;
    console.log(`  ${color(status.status.toUpperCase())} ${status.id} :: ${status.detail}`);
  }
  if (plan.secretBindings.length > 0) {
    console.log('secretBindings:');
    for (const binding of plan.secretBindings) {
      const color = binding.ok ? chalk.green : chalk.red;
      const target = binding.target === 'file' ? (binding.path ?? '(file)') : binding.envName;
      console.log(
        `  ${color(binding.status.toUpperCase())} ${target} <= ${binding.source}${
          binding.vaultKey ? ` (${binding.vaultKey})` : ''
        } :: ${binding.detail}`,
      );
    }
  }
  console.log('steps:');
  plan.steps.forEach((step, index) => console.log(`  ${index + 1}. ${step}`));
  if ('results' in plan && plan.results.length > 0) {
    console.log('results:');
    for (const result of plan.results) {
      console.log(`  [exit=${result.exitCode}] ${result.step}`);
      if (result.stdout.trim().length > 0) console.log(`    stdout: ${result.stdout.trim()}`);
      if (result.stderr.trim().length > 0) console.log(`    stderr: ${result.stderr.trim()}`);
    }
  }
  for (const note of plan.notes) {
    console.log(`note: ${note}`);
  }
}

export async function handleAppsCommand(context: CliContext): Promise<boolean> {
  if (context.args.command !== 'apps') return false;

  const { subcommand, json } = context.args;
  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printAppsHelp(json);
    return true;
  }

  if (subcommand === 'list') {
    const registry = loadManagedAppRegistry(process.env);
    const catalog = inspectManagedAppCatalog(process.env);
    const manifests = catalog.manifests.map((ref) => ({
      ...describeManagedAppManifest(ref),
      installedRecord: registry.apps.find((record) => record.id === ref.manifest.id),
    }));
    if (json) {
      print(
        {
          manifests,
          manifestsDir: catalog.manifestsDir,
          manifestErrors: catalog.errors,
          capabilityCounts: catalog.capabilityCounts,
        },
        true,
      );
    } else if (manifests.length === 0) {
      console.log('No managed app manifests found');
    } else {
      for (const manifest of manifests) {
        console.log(`${manifest.id} :: ${manifest.name} [${manifest.source.kind}]`);
        console.log(`  ${manifest.description}`);
        if (manifest.capabilities.length > 0) {
          console.log(`  capabilities=${manifest.capabilities.join(',')}`);
        }
        if (manifest.capabilityGuidance.length > 0) {
          console.log(
            `  guidance=${manifest.capabilityGuidance.length} capability note(s); use 'memphis apps show ${manifest.id}' for details`,
          );
        }
        if (manifest.capabilityWarnings.length > 0) {
          console.log(`  risk=${manifest.capabilityWarnings.join('; ')}`);
        }
        if (manifest.installedRecord) {
          console.log(
            `  installed=${String(manifest.installedRecord.installed)} state=${manifest.installedRecord.state} last=${manifest.installedRecord.lastAction}`,
          );
        }
      }
      const capabilitySummary =
        Object.entries(catalog.capabilityCounts)
          .filter(([, count]) => count > 0)
          .map(([name, count]) => `${name}=${count}`)
          .join(', ') || 'none';
      console.log(`catalog: ${manifests.length} manifest(s), capabilities=${capabilitySummary}`);
      if (catalog.errors.length > 0) {
        console.log(
          `catalogErrors: ${catalog.errors.length}; inspect JSON/schema under ${catalog.manifestsDir}`,
        );
      }
    }
    return true;
  }

  if (subcommand === 'show') {
    const ref = manifestRefFromContext(context);
    const installedRecord = getManagedAppRegistryRecord(ref.manifest.id, process.env);
    if (json) {
      print({ manifest: describeManagedAppManifest(ref), installedRecord }, true);
    } else {
      printManifestHuman(ref);
    }
    return true;
  }

  if (subcommand === 'plan') {
    const ref = manifestRefFromContext(context);
    const plan = planManagedAppAction(ref, actionNameFromContext(context), {
      rawEnv: process.env,
      apply: false,
    });
    if (json) {
      print(plan, true);
    } else {
      printPlanHuman(plan);
    }
    return true;
  }

  if (subcommand === 'run') {
    const ref = manifestRefFromContext(context);
    const result = executeManagedAppAction(ref, actionNameFromContext(context), {
      rawEnv: process.env,
      apply: context.args.apply,
    });
    const installedRecord = context.args.apply
      ? recordManagedAppExecution(ref, result, process.env)
      : undefined;
    if (json) {
      print({ ...result, installedRecord }, true);
    } else {
      printPlanHuman(result);
    }
    return true;
  }

  if (subcommand === 'validate') {
    if (context.args.file) {
      const result = validateManagedAppManifestFile(context.args.file);
      if (json) {
        print(
          result.ok
            ? { ok: true, manifest: describeManagedAppManifest(result.ref) }
            : { ok: false, path: result.path, error: result.error },
          true,
        );
      } else if (result.ok) {
        console.log(`PASS ${result.ref.manifest.id} :: ${result.ref.manifest.name}`);
      } else {
        console.log(`FAIL ${result.path} :: ${result.error}`);
      }
      if (!result.ok) process.exitCode = 1;
      return true;
    }

    const catalog = inspectManagedAppCatalog(process.env);
    const allOk = catalog.errors.length === 0;
    if (json) {
      print(
        {
          ok: allOk,
          manifestsDir: catalog.manifestsDir,
          passed: catalog.manifests.map((ref) => describeManagedAppManifest(ref)),
          errors: catalog.errors,
        },
        true,
      );
    } else {
      for (const ref of catalog.manifests) {
        console.log(`PASS ${ref.manifest.id} :: ${ref.manifest.name}`);
      }
      for (const err of catalog.errors) {
        console.log(`FAIL ${err.path} :: ${err.detail}`);
      }
      if (catalog.manifests.length === 0 && allOk) {
        console.log(`no manifests in ${catalog.manifestsDir}`);
      } else if (!allOk) {
        console.log(`${catalog.errors.length} error(s) in ${catalog.manifestsDir}`);
      }
    }
    if (!allOk) process.exitCode = 1;
    return true;
  }

  if (subcommand === 'import') {
    if (!context.args.file) {
      throw new Error('apps import requires --file <manifest.json>');
    }
    const result = importManagedAppManifestFile(context.args.file, {
      force: context.args.force,
      rawEnv: process.env,
    });
    if (json) {
      print(result, true);
    } else if (result.ok) {
      console.log(
        `${result.overwritten ? 'overwritten' : 'imported'}: ${result.id} → ${result.dest}`,
      );
    } else {
      console.log(`FAIL ${result.error}`);
    }
    if (!result.ok) process.exitCode = 1;
    return true;
  }

  if (
    ['install', 'start', 'stop', 'restart', 'status', 'doctor', 'dashboard'].includes(subcommand)
  ) {
    const ref = manifestRefFromContext(context);
    const result = executeManagedAppAction(ref, subcommand, {
      rawEnv: process.env,
      apply: context.args.apply,
    });
    const installedRecord = context.args.apply
      ? recordManagedAppExecution(ref, result, process.env)
      : undefined;
    if (json) {
      print({ ...result, installedRecord }, true);
    } else {
      printPlanHuman(result);
    }
    return true;
  }

  throw new Error(`Unknown apps subcommand: ${String(subcommand)}`);
}
