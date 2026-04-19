import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { CommandHandler } from './command-handler.js';
import { rebuildChainIndexes } from '../../../core/chain-index-rebuild.js';
import { AppError } from '../../../core/errors.js';
import { ensureSoulManifest, loadSoulManifest } from '../../../soul/manifest.js';
import { isSoulMemoryEmpty, loadSoulMemory } from '../../../soul/memory.js';
import { seedSoulIdentity } from '../../../soul/seed.js';
import type { Block, TradeOffer } from '../../../sync/types.js';
import {
  soulLoopActionSchema,
  soulLoopLimitsSchema,
  soulLoopStateSchema,
} from '../../config/request-schemas.js';
import { buildOperatorGuide, renderOperatorGuideText } from '../../operator-guide.js';
import { renderSecretAwarenessText } from '../../secret-awareness.js';
import {
  diagnoseChainHashes,
  exportChain,
  rebuildChainHashes,
  verifyChainIntegrity,
} from '../../storage/chain-adapter.js';
import { NapiChainAdapter } from '../../storage/rust-chain-adapter.js';
import { getRustEmbedAdapterStatus } from '../../storage/rust-embed-adapter.js';
import { loadReplayBlocksFromChain, normalizeReplayBlocks } from '../../storage/soul.js';
import type { CliContext } from '../context.js';
import {
  formatImportReport,
  guardWriteMode,
  runImportJsonFromFile,
  transactionalWriteBlocks,
} from '../import-json.js';
import {
  buildHostBootstrapPlan,
  checklistFromEnv,
  runHostBootstrapPlan,
  runWizardInteractive,
  type WizardProfile,
  writeProfileEnv,
} from '../onboarding-wizard.js';
import { checkDependencies } from '../utils/dependencies.js';
import { print } from '../utils/render.js';

const STORAGE_COMMANDS = ['chain', 'onboarding', 'trade', 'soul'] as const;
const WIZARD_PROFILES: WizardProfile[] = [
  'dev-local',
  'prod-shared',
  'prod-decentralized',
  'ollama-local',
];

function resolveWizardProfile(profile?: string): WizardProfile | undefined {
  if (!profile) {
    return undefined;
  }
  return WIZARD_PROFILES.find((candidate) => candidate === profile);
}

type ParsedTradeBlocks = { blocks?: Block[] } | Block[];

function parseJsonOrThrow<T>(raw: string, contextMessage: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new AppError(
      'VALIDATION_ERROR',
      `${contextMessage}. Invalid JSON input. ${reason}`,
      400,
      { reason },
      'Validate the JSON content and retry.',
    );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readTradeBlocks(file: string): Block[] {
  const parsed = parseJsonOrThrow<ParsedTradeBlocks>(
    readFileSync(file, 'utf8'),
    `Failed to parse trade blocks from ${file}`,
  );
  return Array.isArray(parsed) ? parsed : (parsed.blocks ?? []);
}

function ensureApplySafety(context: CliContext, execute: boolean): void {
  const { profile, yes } = context.args;
  if (execute && !yes) {
    throw new Error('onboarding bootstrap --apply requires explicit --yes confirmation');
  }

  if (
    execute &&
    process.env.NODE_ENV === 'production' &&
    profile !== 'prod-shared' &&
    profile !== 'prod-decentralized'
  ) {
    throw new Error(
      'refusing --apply in NODE_ENV=production with non-production profile; use --profile prod-shared|prod-decentralized',
    );
  }
}

async function runBootstrapPreflight(execute: boolean): Promise<void> {
  if (!execute) {
    return;
  }
  const checks = await checkDependencies({ rawEnv: process.env });
  const failed = checks.filter((check) => check.required && !check.ok);
  if (failed.length === 0) {
    return;
  }

  throw new AppError(
    'CONFIG_ERROR',
    `Bootstrap preflight failed: ${failed
      .map((check) => `${check.title}: ${check.detail}`)
      .join('; ')}`,
    500,
    { checks: failed },
    'Run `npm run -s cli -- doctor` and resolve the failed dependency checks before retrying bootstrap.',
  );
}

function buildWizardChecklist() {
  const embed = getRustEmbedAdapterStatus(process.env);
  return checklistFromEnv(process.env).map((item) =>
    item.step !== 'rust-bridge' ? item : { ...item, done: embed.rustEnabled && embed.bridgeLoaded },
  );
}

async function handleChainImport(context: CliContext): Promise<boolean> {
  const { confirmWrite, file, json, out, write } = context.args;
  if (!file) {
    throw new Error('Missing required --file for chain import_json');
  }

  const report = runImportJsonFromFile(file, {
    onProgress: (progress) => {
      if (json || progress.total <= 0) {
        return;
      }
      if (progress.processed !== progress.total && progress.processed % 100 !== 0) {
        return;
      }
      console.log(`[import_json] ${progress.stage}: ${progress.processed}/${progress.total}`);
    },
  });

  const outputPath = resolve(out ?? './data/imported-chain.json');
  guardWriteMode({
    writeEnabled: write,
    confirmationProvided: confirmWrite,
    sourcePath: file,
    destinationPath: outputPath,
  });

  const writeResult =
    write === true
      ? {
          mode: 'write' as const,
          targetPath: outputPath,
          writtenBlocks: report.blocks.length,
          ...transactionalWriteBlocks(outputPath, report.blocks),
        }
      : { mode: 'dry-run' as const, targetPath: outputPath };

  if (json) {
    print({ ...report, write: writeResult }, true);
    return true;
  }

  console.log(formatImportReport(report, writeResult));
  return true;
}

async function handleChainExport(context: CliContext): Promise<boolean> {
  const { chain, json, out } = context.args;
  if (!chain) {
    throw new Error('Missing required --chain for chain export');
  }

  const exported = await exportChain(chain);
  if (!out) {
    console.log(JSON.stringify(exported, null, 2));
    return true;
  }

  const { writeFile } = await import('node:fs/promises');
  const targetPath = resolve(out);
  await writeFile(targetPath, `${JSON.stringify(exported, null, 2)}\n`, 'utf8');

  if (json) {
    print(
      {
        ok: true,
        chain: exported.chainName,
        blockCount: exported.blockCount,
        exportedAt: exported.exportedAt,
        out: targetPath,
      },
      true,
    );
    return true;
  }

  console.log('chain export complete');
  console.log(`chain: ${exported.chainName}`);
  console.log(`blocks: ${exported.blockCount}`);
  console.log(`out: ${targetPath}`);
  return true;
}

async function handleChainCommand(context: CliContext): Promise<boolean> {
  const { chain, command, json, subcommand } = context.args;
  if (command !== 'chain') {
    return false;
  }
  if (subcommand === 'import_json') {
    return handleChainImport(context);
  }
  if (subcommand === 'export') {
    return handleChainExport(context);
  }
  if (subcommand === 'verify') {
    const result = await verifyChainIntegrity(chain);
    print(result, json);
    return true;
  }
  if (subcommand === 'rebuild') {
    const outPath =
      typeof context.args.out === 'string' && context.args.out.length > 0
        ? context.args.out
        : undefined;
    const result = rebuildChainIndexes({ indexFile: outPath });
    print(result, json);
    return true;
  }
  // chain diagnose — reports per-block hash mismatches without mutating
  // anything. Pairs with `chain rebuild-hashes` (below) for repair.
  if (subcommand === 'diagnose') {
    if (!chain) {
      throw new Error('chain diagnose requires --chain <name>');
    }
    const result = await diagnoseChainHashes(chain);
    print(result, json);
    return true;
  }
  // chain rebuild-hashes — destructive; recomputes and writes hashes for
  // every block in the named chain. Disambiguates from `rebuild` (which
  // rebuilds derived indexes, not the on-disk hash columns).
  if (subcommand === 'rebuild-hashes') {
    if (!chain) {
      throw new Error('chain rebuild-hashes requires --chain <name>');
    }
    const result = await rebuildChainHashes(chain);
    print(result, json);
    return true;
  }
  // chain migrate — walks every chain and applies the registered schema
  // migrations (see src/infra/storage/migrations/). Default = dry-run;
  // pass --apply to actually swap dirs. Closes Phase 3.2 production sprint.
  if (subcommand === 'migrate') {
    const { runChainMigrations } = await import('../../storage/migrations/runner.js');
    const result = await runChainMigrations({
      dryRun: context.args.apply !== true,
    });
    print(result, json);
    if (!result.ok) process.exitCode = 1;
    return true;
  }

  // chain restore — gunzips a rotation archive, hash-validates each block,
  // walks the internal prev_hash chain, checks continuity against the
  // active chain tail, and writes each block back. Closes deferred item #6.
  if (subcommand === 'restore') {
    if (!chain) {
      throw new Error('chain restore requires --chain <name>');
    }
    const archivePath = context.args.file;
    if (!archivePath) {
      throw new Error('chain restore requires --file <path-to-archive.jsonl.gz>');
    }
    const { restoreChainFromArchive } = await import('../../storage/chain-archive-restore.js');
    const result = await restoreChainFromArchive(chain, archivePath, {
      allowDiscontinuousRestore: context.args.force === true,
    });
    print(result, json);
    return true;
  }
  // Explicit unknown-subcommand error so the operator sees the closed
  // door instead of a silent fall-through. Throws (Codex P1 fix in
  // PR #99) so `memphis chain verfiy` typos exit non-zero in CI.
  if (subcommand !== undefined && subcommand !== '') {
    const available = [
      'import_json',
      'export',
      'verify',
      'rebuild',
      'diagnose',
      'rebuild-hashes',
      'restore',
      'migrate',
    ];
    throw new Error(`Unknown chain subcommand: ${subcommand}. Available: ${available.join(', ')}.`);
  }
  return false;
}

async function handleOnboardingBootstrap(context: CliContext): Promise<boolean> {
  const { apply, dryRun, force, json, out, profile } = context.args;
  const resolvedProfile = resolveWizardProfile(profile);
  if (profile && !resolvedProfile) {
    throw new Error(`Unsupported onboarding profile: ${profile}`);
  }
  const plan = buildHostBootstrapPlan(resolvedProfile ?? 'dev-local', out ?? '.env', force);
  const execute = apply === true && dryRun !== true;
  ensureApplySafety(context, execute);
  await runBootstrapPreflight(execute);

  const result = runHostBootstrapPlan(plan, execute);
  print({ ok: result.ok, mode: result.mode, plan: result.plan, executed: result.executed }, json);
  return true;
}

async function handleOnboardingWizard(context: CliContext): Promise<boolean> {
  const { force, interactive, json, out, profile, write } = context.args;
  const resolvedProfile = resolveWizardProfile(profile);
  if (profile && !resolvedProfile) {
    throw new Error(`Unsupported onboarding profile: ${profile}`);
  }
  if (interactive) {
    const result = {
      ok: true,
      interactive: true,
      ...(await runWizardInteractive(resolvedProfile ?? 'dev-local')),
    };
    if (json) {
      print({ ...result, guide: buildOperatorGuide(process.env) }, true);
    } else {
      print(result, false);
      console.log('');
      console.log(renderOperatorGuideText(process.env));
    }
    return true;
  }

  if (write) {
    if (!profile) {
      throw new Error('onboarding wizard --write requires --profile');
    }
    const writeResult = writeProfileEnv(resolvedProfile!, out ?? '.env', force);
    if (json) {
      print({ ok: true, write: writeResult }, true);
    } else {
      print({ ok: true, write: writeResult }, false);
      console.log('');
      console.log(renderSecretAwarenessText(writeResult.secretAwareness));
    }
    return true;
  }

  const checklist = buildWizardChecklist();
  const doneCount = checklist.filter((item) => item.done).length;
  const payload = {
    ok: doneCount === checklist.length,
    progress: `${doneCount}/${checklist.length}`,
    checklist,
    profiles: ['dev-local', 'prod-shared', 'prod-decentralized', 'ollama-local'],
  };
  if (json) {
    print({ ...payload, guide: buildOperatorGuide(process.env) }, true);
  } else {
    print(payload, false);
    console.log('');
    console.log(renderOperatorGuideText(process.env));
  }
  return true;
}

async function handleOnboardingCommand(context: CliContext): Promise<boolean> {
  const { command, subcommand } = context.args;
  if (command !== 'onboarding') {
    return false;
  }
  if (subcommand === 'bootstrap') {
    return handleOnboardingBootstrap(context);
  }
  if (subcommand === 'wizard') {
    return handleOnboardingWizard(context);
  }
  return false;
}

async function handleTradeOffer(context: CliContext): Promise<boolean> {
  const { blocks, file, json, recipient } = context.args;
  if (!recipient) {
    throw new Error('trade offer requires --recipient <did:...>');
  }

  const { TradeProtocol } = await import('../../../sync/trade.js');
  const { NetworkChain } = await import('../../../sync/network-chain.js');
  const trade = new TradeProtocol();
  const ledger = new NetworkChain();

  const offerBlocks =
    file && existsSync(file) ? readTradeBlocks(file) : blocks ? [{ content: blocks }] : [];
  const offer = await trade.createOffer(offerBlocks, recipient as `did:${string}`);

  ledger.append({
    action: 'trade.offer',
    actor: offer.sender,
    offerId: offer.id,
    details: { recipient },
  });
  print({ ok: true, mode: 'trade-offer', offer }, json);
  return true;
}

async function handleTradeAccept(context: CliContext): Promise<boolean> {
  const { file, json, offerId } = context.args;
  if (!file || !existsSync(file)) {
    throw new Error('trade accept requires --file <offer.json>');
  }

  const { TradeProtocol } = await import('../../../sync/trade.js');
  const { NetworkChain } = await import('../../../sync/network-chain.js');
  const trade = new TradeProtocol();
  const ledger = new NetworkChain();

  const offer = parseJsonOrThrow<TradeOffer>(
    readFileSync(file, 'utf8'),
    `Failed to parse trade offer from ${file}`,
  );
  if (offerId && offer.id !== offerId) {
    throw new Error(`offer-id mismatch: expected ${offerId}, got ${offer.id}`);
  }

  await trade.acceptOffer(offer);
  ledger.append({
    action: 'trade.accept',
    actor: 'system',
    offerId: offer.id,
    details: { recipient: offer.recipient },
  });
  print({ ok: true, mode: 'trade-accept', offerId: offer.id }, json);
  return true;
}

async function handleTradeCommand(context: CliContext): Promise<boolean> {
  const { command, subcommand } = context.args;
  if (command !== 'trade') {
    return false;
  }
  if (subcommand === 'offer') {
    return handleTradeOffer(context);
  }
  if (subcommand === 'accept') {
    return handleTradeAccept(context);
  }

  throw new Error(`Unknown trade subcommand: ${String(subcommand)}`);
}

async function handleSoulReplay(context: CliContext): Promise<boolean> {
  const chain = context.args.chain ?? 'system';
  const adapter = new NapiChainAdapter(process.env);

  let blocks;
  if (context.args.file) {
    const parsed = parseJsonOrThrow<unknown>(
      readFileSync(context.args.file, 'utf8'),
      `Failed to parse soul replay payload from ${context.args.file}`,
    );
    const rawBlocks = Array.isArray(parsed)
      ? parsed
      : isObject(parsed) && Array.isArray(parsed.blocks)
        ? parsed.blocks
        : null;
    if (!rawBlocks) {
      throw new Error('soul replay file must contain an array or { blocks: [] }');
    }
    blocks = normalizeReplayBlocks(rawBlocks, chain);
  } else {
    blocks = await loadReplayBlocksFromChain(chain, process.env);
  }

  if (context.args.latest && context.args.latest > 0) {
    blocks = blocks.slice(-context.args.latest);
  }

  const report = adapter.soulReplay(chain, blocks);
  print({ ok: true, chain, count: blocks.length, report }, context.args.json);
  return true;
}

async function handleSoulStep(context: CliContext): Promise<boolean> {
  const adapter = new NapiChainAdapter(process.env);
  const actionRaw = context.args.action ?? context.args.input;
  if (!actionRaw) {
    throw new Error('soul step requires --action <json> (or --input <json>)');
  }

  const defaultState = {
    steps: 0,
    tool_calls: 0,
    wait_ms: 0,
    errors: 0,
    completed: false,
    halt_reason: null,
  };

  const stateParsed = soulLoopStateSchema.safeParse(
    context.args.state
      ? parseJsonOrThrow<unknown>(context.args.state, 'Failed to parse --state JSON')
      : defaultState,
  );
  if (!stateParsed.success) {
    throw new Error(
      `invalid --state payload: ${stateParsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }

  const actionParsed = soulLoopActionSchema.safeParse(
    parseJsonOrThrow<unknown>(actionRaw, 'Failed to parse --action JSON'),
  );
  if (!actionParsed.success) {
    throw new Error(
      `invalid --action payload: ${actionParsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }

  const limitsParsed = context.args.limits
    ? soulLoopLimitsSchema.safeParse(
        parseJsonOrThrow<unknown>(context.args.limits, 'Failed to parse --limits JSON'),
      )
    : null;
  if (limitsParsed && !limitsParsed.success) {
    throw new Error(
      `invalid --limits payload: ${limitsParsed.error.issues[0]?.message ?? 'unknown'}`,
    );
  }

  const result = adapter.soulLoopStep(
    stateParsed.data,
    actionParsed.data,
    limitsParsed?.success ? limitsParsed.data : undefined,
  );
  print({ ok: true, result }, context.args.json);
  return true;
}

async function handleSoulShow(context: CliContext): Promise<boolean> {
  const { json } = context.args;
  const manifest = loadSoulManifest() ?? ensureSoulManifest();
  const memory = loadSoulMemory();

  const summary = {
    identity: {
      agent: manifest.identity.agentName,
      owner: manifest.identity.ownerName,
      mode: manifest.identity.runtimeMode,
      created: manifest.identity.createdAt,
    },
    capabilities: {
      tools: manifest.capabilities.tools.length,
      chains: manifest.capabilities.chains.length,
      rustBridge: manifest.capabilities.rustBridge,
    },
    memory: memory
      ? {
          empty: isSoulMemoryEmpty(memory),
          lastUpdated: memory.lastUpdated,
          userName: memory.user.name ?? null,
          languages: memory.user.languages,
          preferences: memory.user.preferences.length,
          learnings: memory.self.learnings.length,
          activeWork: memory.context.activeWork ?? null,
        }
      : null,
  };

  print(summary, json);
  return true;
}

async function handleSoulManifest(context: CliContext): Promise<boolean> {
  const { json } = context.args;
  const manifest = loadSoulManifest() ?? ensureSoulManifest();
  print(manifest, json);
  return true;
}

async function handleSoulMemory(context: CliContext): Promise<boolean> {
  const { json } = context.args;
  const memory = loadSoulMemory();

  if (!memory) {
    print(
      {
        ok: true,
        memory: null,
        message: 'No soul memory found. Start a conversation to initialize.',
      },
      json,
    );
    return true;
  }

  print(memory, json);
  return true;
}

async function handleSoulSeed(context: CliContext): Promise<boolean> {
  const { json } = context.args;
  const result = await seedSoulIdentity();

  if (result.skipped) {
    print({ ok: true, skipped: true, message: 'Soul already seeded — skipping.' }, json);
    return true;
  }

  const summary = {
    ok: result.errors.length === 0,
    seeded: result.seeded,
    soulMemory: result.soulMemory,
    journalEntries: result.journalEntries,
    caseEntries: result.caseEntries,
    errors: result.errors.length > 0 ? result.errors : undefined,
  };

  if (!json) {
    console.log(`\n  Soul seed complete:`);
    console.log(`    Soul memory: ${result.soulMemory ? 'initialized' : 'failed'}`);
    console.log(`    Journal entries: ${result.journalEntries}/5`);
    console.log(`    Case entries: ${result.caseEntries}/8`);
    if (result.errors.length > 0) {
      console.log(`    Errors: ${result.errors.length}`);
      for (const err of result.errors) {
        console.log(`      - ${err}`);
      }
    }
    console.log('');
  }

  print(summary, json);
  return true;
}

async function handleSoulCommand(context: CliContext): Promise<boolean> {
  const { command, subcommand } = context.args;
  if (command !== 'soul') {
    return false;
  }
  if (subcommand === 'show') {
    return handleSoulShow(context);
  }
  if (subcommand === 'manifest') {
    return handleSoulManifest(context);
  }
  if (subcommand === 'memory') {
    return handleSoulMemory(context);
  }
  if (subcommand === 'replay') {
    return handleSoulReplay(context);
  }
  if (subcommand === 'step') {
    return handleSoulStep(context);
  }
  if (subcommand === 'seed') {
    return handleSoulSeed(context);
  }

  throw new Error(
    `Unknown soul subcommand: ${String(subcommand)}. Use show|manifest|memory|replay|step|seed`,
  );
}

export const storageCommandHandler: CommandHandler = {
  name: 'storage',
  commands: STORAGE_COMMANDS,
  canHandle(context: CliContext): boolean {
    return STORAGE_COMMANDS.includes(context.args.command as (typeof STORAGE_COMMANDS)[number]);
  },
  async handle(context: CliContext): Promise<boolean> {
    if (await handleChainCommand(context)) {
      return true;
    }
    if (await handleOnboardingCommand(context)) {
      return true;
    }
    if (await handleSoulCommand(context)) {
      return true;
    }
    return handleTradeCommand(context);
  },
};
