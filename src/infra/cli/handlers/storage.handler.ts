import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppError } from '../../../core/errors.js';
import { verifyChainIntegrity } from '../../storage/chain-adapter.js';
import { getRustEmbedAdapterStatus } from '../../storage/rust-embed-adapter.js';
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
  writeProfileEnv,
} from '../onboarding-wizard.js';
import { checkDependencies } from '../utils/dependencies.js';
import { print } from '../utils/render.js';
import type { CommandHandler } from './command-handler.js';

const STORAGE_COMMANDS = ['chain', 'onboarding', 'trade'] as const;

function readTradeBlocks(file: string): unknown[] {
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { blocks?: unknown[] } | unknown[];
  return Array.isArray(parsed) ? parsed : (parsed.blocks ?? []);
}

export const storageCommandHandler: CommandHandler = {
  name: 'storage',
  commands: STORAGE_COMMANDS,
  canHandle(context: CliContext): boolean {
    return STORAGE_COMMANDS.includes(context.args.command as (typeof STORAGE_COMMANDS)[number]);
  },
  async handle(context: CliContext): Promise<boolean> {
    const {
      apply,
      blocks,
      chain,
      command,
      confirmWrite,
      dryRun,
      file,
      force,
      interactive,
      json,
      offerId,
      out,
      profile,
      recipient,
      subcommand,
      write,
      yes,
    } = context.args;

    if (command === 'chain' && subcommand === 'import_json') {
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

    if (command === 'chain' && subcommand === 'verify') {
      const result = await verifyChainIntegrity(chain);
      print(result, json);
      return true;
    }

    if (command === 'chain' && subcommand === 'rebuild') {
      return false;
    }

    if (command === 'onboarding' && subcommand === 'bootstrap') {
      const plan = buildHostBootstrapPlan(profile ?? 'dev-local', out ?? '.env', force);
      const execute = apply === true && dryRun !== true;

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

      if (execute) {
        const checks = await checkDependencies({ rawEnv: process.env });
        const failed = checks.filter((check) => check.required && !check.ok);
        if (failed.length > 0) {
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
      }

      const result = runHostBootstrapPlan(plan, execute);
      print(
        { ok: result.ok, mode: result.mode, plan: result.plan, executed: result.executed },
        json,
      );
      return true;
    }

    if (command === 'onboarding' && subcommand === 'wizard') {
      if (interactive) {
        print(
          { ok: true, interactive: true, ...(await runWizardInteractive(profile ?? 'dev-local')) },
          json,
        );
        return true;
      }

      if (write) {
        if (!profile) {
          throw new Error('onboarding wizard --write requires --profile');
        }
        print({ ok: true, write: writeProfileEnv(profile, out ?? '.env', force) }, json);
        return true;
      }

      const embed = getRustEmbedAdapterStatus(process.env);
      const checklist = checklistFromEnv(process.env).map((item) =>
        item.step !== 'rust-bridge'
          ? item
          : { ...item, done: embed.rustEnabled && embed.bridgeLoaded },
      );
      const doneCount = checklist.filter((item) => item.done).length;
      print(
        {
          ok: doneCount === checklist.length,
          progress: `${doneCount}/${checklist.length}`,
          checklist,
          profiles: ['dev-local', 'prod-shared', 'prod-decentralized', 'ollama-local'],
        },
        json,
      );
      return true;
    }

    if (command === 'trade') {
      const { TradeProtocol } = await import('../../../sync/trade.js');
      const { NetworkChain } = await import('../../../sync/network-chain.js');
      const trade = new TradeProtocol();
      const ledger = new NetworkChain();

      if (subcommand === 'offer') {
        if (!recipient) {
          throw new Error('trade offer requires --recipient <did:...>');
        }
        const offerBlocks =
          file && existsSync(file) ? readTradeBlocks(file) : blocks ? [{ range: blocks }] : [];
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

      if (subcommand === 'accept') {
        if (!file || !existsSync(file)) {
          throw new Error('trade accept requires --file <offer.json>');
        }
        const offer = JSON.parse(readFileSync(file, 'utf8')) as {
          id: string;
          recipient: string;
        };
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

      throw new Error(`Unknown trade subcommand: ${String(subcommand)}`);
    }

    return false;
  },
};
