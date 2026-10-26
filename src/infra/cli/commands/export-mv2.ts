import { resolve } from 'node:path';

import { exportMv2Snapshot } from '../../storage/mv2-snapshot.js';
import type { CliContext } from '../context.js';

export async function handleExportMv2Command(context: CliContext): Promise<boolean> {
  if (context.args.command !== 'export' || context.args.format !== 'mv2') return false;
  if (!context.args.out?.trim()) {
    process.stderr.write('memphis export --format=mv2 requires --output PATH\n');
    process.exitCode = 2;
    return true;
  }
  try {
    const output = resolve(context.args.out);
    const result = await exportMv2Snapshot(output, context.args.include, process.env);
    const payload = {
      ok: true,
      format: 'mv2',
      output,
      frameCount: result.blockCount + 1,
      blockCount: result.blockCount,
      bytes: result.bytes,
      chains: result.manifest.chains,
      signed: true,
      signerDid: result.manifest.signerDid,
    };
    process.stdout.write(
      context.args.json
        ? JSON.stringify(payload, null, 2) + '\n'
        : `Wrote ${result.blockCount} blocks to ${output} (signed MV2 snapshot)\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'MV2 export failed'}\n`);
    process.exitCode = 2;
  }
  return true;
}
