import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  formatImportReport,
  guardWriteMode,
  runImportJsonFromFile,
  transactionalWriteBlocks,
} from '../import-json.js';
import { listVaultEntries, saveVaultEntry } from '../../storage/vault-entry-store.js';
import { vaultDecrypt, vaultEncrypt, vaultInit } from '../../storage/rust-vault-adapter.js';
import {
  embedReset,
  embedSearch,
  embedSearchTuned,
  embedStore,
  getRustEmbedAdapterStatus,
} from '../../storage/rust-embed-adapter.js';
import { buildHostBootstrapPlan, checklistFromEnv, runHostBootstrapPlan, runWizardInteractive, writeProfileEnv } from '../onboarding-wizard.js';
import { print } from '../utils/render.js';
import type { CliContext } from '../context.js';

export async function handleStorageCommand(context: CliContext): Promise<boolean> {
  const { args } = context;
  const {
    command,
    subcommand,
    json,
    id,
    value,
    query,
    tuned,
    topK,
    out,
    file,
    write,
    confirmWrite,
    passphrase,
    recoveryQuestion,
    recoveryAnswer,
    key,
    profile,
    force,
    apply,
    dryRun,
    yes,
    interactive,
  } = args;

  if (command === 'embed') {
    if (subcommand === 'reset') {
      print({ ok: true, data: embedReset(process.env) }, json);
      return true;
    }

    if (subcommand === 'store') {
      if (!id || value === undefined) throw new Error('embed store requires --id and --value');
      print({ ok: true, data: embedStore(id, value, process.env) }, json);
      return true;
    }

    if (subcommand === 'search') {
      if (!query) throw new Error('embed search requires --query');
      const data = tuned ? embedSearchTuned(query, topK ?? 5, process.env) : embedSearch(query, topK ?? 5, process.env);
      print({ ok: true, data }, json);
      return true;
    }

    throw new Error(`Unknown embed subcommand: ${String(subcommand)}`);
  }

  if (command === 'chain' && subcommand === 'import_json') {
    if (!file) throw new Error('Missing required --file for chain import_json');

    const report = runImportJsonFromFile(file, {
      onProgress: (progress) => {
        if (json) return;
        if (progress.total <= 0) return;
        if (progress.processed !== progress.total && progress.processed % 100 !== 0) return;
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

  if (command === 'vault') {
    if (subcommand === 'init') {
      if (!passphrase || !recoveryQuestion || !recoveryAnswer) {
        throw new Error('vault init requires --passphrase --recovery-question --recovery-answer');
      }
      print(
        {
          ok: true,
          vault: vaultInit({ passphrase, recovery_question: recoveryQuestion, recovery_answer: recoveryAnswer }, process.env),
        },
        json,
      );
      return true;
    }

    if (subcommand === 'add') {
      if (!key || value === undefined) throw new Error('vault add requires --key and --value');
      const encrypted = vaultEncrypt(key, value, process.env);
      print({ ok: true, entry: saveVaultEntry(encrypted, process.env) }, json);
      return true;
    }

    if (subcommand === 'get') {
      if (!key) throw new Error('vault get requires --key');
      const entries = listVaultEntries(process.env, key);
      const latest = entries.at(-1);
      if (!latest) throw new Error(`vault key not found: ${key}`);
      print({ ok: true, key, value: vaultDecrypt(latest, process.env) }, json);
      return true;
    }

    if (subcommand === 'list') {
      print({ ok: true, entries: listVaultEntries(process.env, key) }, json);
      return true;
    }

    throw new Error(`Unknown vault subcommand: ${String(subcommand)}`);
  }

  if (command === 'onboarding' && subcommand === 'bootstrap') {
    const plan = buildHostBootstrapPlan(profile ?? 'dev-local', out ?? '.env', force);
    const execute = apply === true && dryRun !== true;

    if (execute && !yes) {
      throw new Error('onboarding bootstrap --apply requires explicit --yes confirmation');
    }

    if (execute && process.env.NODE_ENV === 'production' && profile !== 'prod-shared' && profile !== 'prod-decentralized') {
      throw new Error('refusing --apply in NODE_ENV=production with non-production profile; use --profile prod-shared|prod-decentralized');
    }

    const result = runHostBootstrapPlan(plan, execute);
    print({ ok: result.ok, mode: result.mode, plan: result.plan, executed: result.executed }, json);
    return true;
  }

  if (command === 'onboarding' && subcommand === 'wizard') {
    if (interactive) {
      print({ ok: true, interactive: true, ...(await runWizardInteractive(profile ?? 'dev-local')) }, json);
      return true;
    }

    if (write) {
      if (!profile) throw new Error('onboarding wizard --write requires --profile');
      print({ ok: true, write: writeProfileEnv(profile, out ?? '.env', force) }, json);
      return true;
    }

    const embed = getRustEmbedAdapterStatus(process.env);
    const checklist = checklistFromEnv(process.env).map((item) =>
      item.step !== 'rust-bridge' ? item : { ...item, done: embed.rustEnabled && embed.bridgeLoaded },
    );
    const doneCount = checklist.filter((x) => x.done).length;
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
      if (!args.recipient) throw new Error('trade offer requires --recipient <did:...>');
      let offerBlocks = [];
      if (file && existsSync(file)) {
        const parsed = JSON.parse(readFileSync(file, 'utf8'));
        offerBlocks = Array.isArray(parsed) ? parsed : (parsed.blocks ?? []);
      } else if (args.blocks) {
        offerBlocks = [{ range: args.blocks }];
      }
      const offer = await trade.createOffer(offerBlocks, args.recipient as `did:${string}`);
      ledger.append({ action: 'trade.offer', actor: offer.sender, offerId: offer.id, details: { recipient: args.recipient } });
      print({ ok: true, mode: 'trade-offer', offer }, json);
      return true;
    }

    if (subcommand === 'accept') {
      if (!file || !existsSync(file)) throw new Error('trade accept requires --file <offer.json>');
      const offer = JSON.parse(readFileSync(file, 'utf8'));
      if (args.offerId && offer.id !== args.offerId) throw new Error(`offer-id mismatch: expected ${args.offerId}, got ${offer.id}`);
      await trade.acceptOffer(offer);
      ledger.append({ action: 'trade.accept', actor: 'system', offerId: offer.id, details: { recipient: offer.recipient } });
      print({ ok: true, mode: 'trade-accept', offerId: offer.id }, json);
      return true;
    }

    throw new Error(`Unknown trade subcommand: ${String(subcommand)}`);
  }

  return false;
}
