import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';
import { previewMv2Restore, restoreMv2Snapshot } from '../../storage/mv2-snapshot.js';

export const importCommandHandler: CommandHandler = {
  name: 'import',
  commands: ['import'],
  canHandle: (context) => context.args.command === 'import',
  async handle(context: CliContext): Promise<boolean> {
    const { args } = context;
    try {
      if (!args.fromMv2 || !args.into)
        throw new Error('MV2 import requires --from-mv2 FILE --into FRESH_DIRECTORY');
      if (!args.dryRun && !(args.write && args.confirmWrite))
        throw new Error('MV2 import requires --dry-run or --write --confirm-write');
      if (args.dryRun && args.write) throw new Error('Choose either dry-run or write');
      const snapshot = args.dryRun
        ? await previewMv2Restore(args.fromMv2, args.into, process.env, args.trustedSigner)
        : await restoreMv2Snapshot(args.fromMv2, args.into, process.env, args.trustedSigner);
      const payload = {
        ok: true,
        valid: true,
        mode: args.dryRun ? 'dry-run' : 'write',
        blockCount: snapshot.blockCount,
        chains: snapshot.manifest.chains,
        signerDid: snapshot.manifest.signerDid,
        target: 'target' in snapshot ? snapshot.target : args.into,
      };
      process.stdout.write(JSON.stringify(payload, null, args.json ? 2 : undefined) + '\n');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'MV2 import failed';
      if (args.json)
        process.stdout.write(JSON.stringify({ ok: false, valid: false, error: message }) + '\n');
      else process.stderr.write(message + '\n');
      process.exitCode = 2;
    }
    return true;
  },
};
