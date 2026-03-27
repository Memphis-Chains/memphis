import chalk from 'chalk';

import { KnowledgeService } from '../../../modules/knowledge/service.js';
import type { CliContext } from '../context.js';
import { print } from '../utils/render.js';

const KNOWLEDGE_SUBCOMMANDS = new Set(['status', 'sources', 'query']);

export async function handleKnowledgeCommand(context: CliContext): Promise<boolean> {
  if (context.args.command !== 'knowledge') {
    return false;
  }

  const service = new KnowledgeService({ workspaceRoot: process.cwd() });
  const subcommand = context.args.subcommand;

  if (!subcommand || subcommand === 'status') {
    const result = service.buildStatus();
    printKnowledgeStatus(result, context.args.json);
    return true;
  }

  if (subcommand === 'sources') {
    const result = service.listSources();
    printKnowledgeStatus(result, context.args.json);
    return true;
  }

  if (subcommand === 'query') {
    const topic = resolveKnowledgeTopic(context);
    const result = service.query(topic, {
      source: context.args.source,
      limit: context.args.limit,
    });
    printKnowledgeQuery(result, context.args.json);
    return true;
  }

  const shorthandTopic = resolveKnowledgeTopic(context);
  const result = service.query(shorthandTopic, {
    source: context.args.source,
    limit: context.args.limit,
  });
  printKnowledgeQuery(result, context.args.json);
  return true;
}

function resolveKnowledgeTopic(context: CliContext): string {
  const explicit = context.args.topic ?? context.args.query;
  if (explicit?.trim()) {
    return explicit.trim();
  }

  if (context.args.subcommand === 'query') {
    const positional = collectKnowledgePositionalTokens(context.argv.slice(4));
    if (positional.length > 0) {
      return positional.join(' ');
    }
  }

  const subcommand = context.args.subcommand;
  if (subcommand && !KNOWLEDGE_SUBCOMMANDS.has(subcommand)) {
    return collectKnowledgePositionalTokens(context.argv.slice(3)).join(' ');
  }

  throw new Error('knowledge query requires --topic <text> or a positional topic');
}

function collectKnowledgePositionalTokens(tokens: string[]): string[] {
  const positionals: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--topic' || token === '--source' || token === '--limit' || token === '--query') {
      index += 1;
      continue;
    }
    if (token.startsWith('--')) {
      continue;
    }
    positionals.push(token);
  }

  return positionals;
}

function printKnowledgeStatus(
  result: ReturnType<KnowledgeService['buildStatus']>,
  json: boolean,
): void {
  if (json) {
    print(result, true);
    return;
  }

  console.log(chalk.cyan('Knowledge sources'));
  console.log(
    `  loaded=${result.summary.loaded} missing_optional=${result.summary.missingOptional} missing_required=${result.summary.missingRequired}`,
  );
  console.log(`  workspace=${result.workspaceRoot}`);
  console.log('');

  for (const source of result.sources) {
    const availability = source.available ? chalk.green('loaded') : chalk.yellow('missing');
    console.log(`  - ${source.id} :: ${availability}`);
    console.log(`    ${source.path}`);
    console.log(`    ${source.description}`);
    if (source.available) {
      console.log(
        `    sections=${source.sectionCount} bytes=${source.bytes} updated=${source.modifiedAt}`,
      );
    } else if (source.warning) {
      console.log(`    warning=${source.warning}`);
    }
  }
}

function printKnowledgeQuery(result: ReturnType<KnowledgeService['query']>, json: boolean): void {
  if (json) {
    print(result, true);
    return;
  }

  console.log(chalk.cyan(`Knowledge query: ${result.topic}`));
  if (result.source) {
    console.log(`  source=${result.source}`);
  }
  console.log(`  hits=${result.hits.length} available_sources=${result.availableSources}`);
  console.log('');

  if (result.hits.length === 0) {
    console.log('  No matching knowledge hits.');
    return;
  }

  for (const hit of result.hits) {
    console.log(`  - ${hit.sourceId} :: ${hit.section} :: score=${hit.score}`);
    console.log(`    ${hit.snippet}`);
  }
}
