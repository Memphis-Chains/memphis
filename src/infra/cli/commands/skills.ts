import chalk from 'chalk';

import {
  createSkillScaffold,
  describeSkillManifest,
  getSkillManifest,
  importSkillManifestFile,
  inspectSkillCatalog,
  materializeInstalledSkill,
  validateSkillManifestFile,
} from '../../../modules/skills/catalog.js';
import {
  getSkillRegistryRecord,
  listSkillRegistryRecords,
  recordInstalledSkill,
} from '../../../modules/skills/registry.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

function printSkillsHelp(json: boolean): void {
  print(
    {
      usage:
        'memphis skills list|show <id>|install <id>|create <id> [--name <name>] [--description <text>] [--tools <tool1,tool2>] [--out <dir>] | validate [--file <manifest.json>] | import --file <manifest.json> [--force] [--json]',
      notes:
        'Catalog merges built-in starter skills with local catalog entries under ~/.memphis/skills/catalog. Install materializes SKILL.md plus manifest.json under ~/.memphis/skills/installed/<id>/.',
    },
    json,
  );
}

function manifestRefFromContext(context: CliContext) {
  return getSkillManifest({
    id: context.args.target,
    file: context.args.file,
    rawEnv: process.env,
  });
}

function printSkillHuman(ref: ReturnType<typeof manifestRefFromContext>): void {
  const summary = describeSkillManifest(ref);
  const record = getSkillRegistryRecord(summary.id, process.env);

  console.log(chalk.cyan(`${summary.name} (${summary.id})`));
  console.log(summary.description);
  console.log(
    `source: ${summary.source.kind}${summary.source.path ? ` (${summary.source.path})` : ''}`,
  );
  console.log(`tags: ${summary.tags.length > 0 ? summary.tags.join(', ') : 'none'}`);
  console.log(`tools: ${summary.tools.length > 0 ? summary.tools.join(', ') : 'none declared'}`);
  console.log(
    `workflow: ${summary.workflowCount} step(s), prompt hints: ${summary.promptHintCount}, examples: ${summary.exampleCount}`,
  );
  if (record) {
    console.log(`installed: ${String(record.installed)} @ ${record.installedPath}`);
  }
}

export async function handleSkillsCommand(context: CliContext): Promise<boolean> {
  if (context.args.command !== 'skills' && context.args.command !== 'skill') {
    return false;
  }

  const { subcommand, json } = context.args;
  if (!subcommand || subcommand === 'help' || subcommand === '--help') {
    printSkillsHelp(json);
    return true;
  }

  if (subcommand === 'list') {
    const catalog = inspectSkillCatalog(process.env);
    const registry = listSkillRegistryRecords(process.env);
    const manifests = catalog.manifests.map((ref) => ({
      ...describeSkillManifest(ref),
      installedRecord: registry.find((record) => record.id === ref.manifest.id),
    }));

    if (json) {
      print(
        {
          manifests,
          catalogDir: catalog.catalogDir,
          installedDir: catalog.installedDir,
          draftsDir: catalog.draftsDir,
          catalogErrors: catalog.errors,
        },
        true,
      );
    } else if (manifests.length === 0) {
      console.log('No skill manifests found');
    } else {
      for (const manifest of manifests) {
        console.log(`${manifest.id} :: ${manifest.name} [${manifest.source.kind}]`);
        console.log(`  ${manifest.description}`);
        console.log(`  tags=${manifest.tags.length > 0 ? manifest.tags.join(',') : 'none'}`);
        console.log(`  tools=${manifest.tools.length > 0 ? manifest.tools.join(',') : 'none'}`);
        if (manifest.installedRecord) {
          console.log(`  installed=true path=${manifest.installedRecord.installedPath}`);
        }
      }
      console.log(
        `catalog: ${manifests.length} skill(s), installed=${registry.length}, errors=${catalog.errors.length}`,
      );
    }
    return true;
  }

  if (subcommand === 'show') {
    const ref = manifestRefFromContext(context);
    const installedRecord = getSkillRegistryRecord(ref.manifest.id, process.env);
    if (json) {
      print({ manifest: describeSkillManifest(ref), installedRecord }, true);
    } else {
      printSkillHuman(ref);
    }
    return true;
  }

  if (subcommand === 'create') {
    if (!context.args.target?.trim()) {
      throw new Error('skills create requires an id');
    }

    const result = createSkillScaffold({
      id: context.args.target,
      name: context.args.name,
      description: context.args.description,
      tools: context.args.tools,
      out: context.args.out,
      force: context.args.force,
      rawEnv: process.env,
    });
    if (json) {
      print(result, true);
    } else {
      console.log(chalk.green(`Created skill scaffold ${result.ref.manifest.id}`));
      console.log(`  output: ${result.outputDir}`);
      console.log(`  manifest: ${result.manifestPath}`);
      console.log(`  skill: ${result.skillPath}`);
    }
    return true;
  }

  if (subcommand === 'validate') {
    if (context.args.file) {
      const result = validateSkillManifestFile(context.args.file);
      if (json) {
        print(
          result.ok
            ? { ok: true, manifest: describeSkillManifest(result.ref) }
            : { ok: false, path: result.path, detail: result.detail },
          true,
        );
      } else if (result.ok) {
        console.log(`PASS ${result.ref.manifest.id} :: ${result.ref.manifest.name}`);
      } else {
        console.log(`FAIL ${result.path} :: ${result.detail}`);
      }
      if (!result.ok) {
        process.exitCode = 1;
      }
      return true;
    }

    const catalog = inspectSkillCatalog(process.env);
    const ok = catalog.errors.length === 0;
    if (json) {
      print(
        {
          ok,
          catalogDir: catalog.catalogDir,
          checked: catalog.manifests.map((ref) => describeSkillManifest(ref)),
          errors: catalog.errors,
        },
        true,
      );
    } else {
      for (const ref of catalog.manifests) {
        console.log(`PASS ${ref.manifest.id} :: ${ref.manifest.name}`);
      }
      for (const error of catalog.errors) {
        console.log(`FAIL ${error.path} :: ${error.detail}`);
      }
      if (catalog.manifests.length === 0 && ok) {
        console.log(`no skills in ${catalog.catalogDir}`);
      }
    }
    if (!ok) {
      process.exitCode = 1;
    }
    return true;
  }

  if (subcommand === 'import') {
    if (!context.args.file) {
      throw new Error('skills import requires --file <manifest.json>');
    }

    const result = importSkillManifestFile(context.args.file, {
      force: context.args.force,
      rawEnv: process.env,
    });
    if (json) {
      print(result, true);
    } else {
      console.log(chalk.green(`Imported skill ${result.ref.manifest.id}`));
      console.log(`  manifest: ${result.manifestPath}`);
      console.log(`  skill: ${result.skillPath}`);
    }
    return true;
  }

  if (subcommand === 'install') {
    const ref = manifestRefFromContext(context);
    const materialized = materializeInstalledSkill(ref, {
      force: context.args.force,
      rawEnv: process.env,
    });
    const record = recordInstalledSkill(ref, materialized, process.env);
    if (json) {
      print({ install: materialized, record }, true);
    } else {
      console.log(chalk.green(`Installed skill ${ref.manifest.id}`));
      console.log(`  installed: ${materialized.installedPath}`);
      console.log(`  catalog: ${materialized.catalogPath}`);
    }
    return true;
  }

  return false;
}
