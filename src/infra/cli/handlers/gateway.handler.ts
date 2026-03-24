import type { CliContext } from '../context.js';
import type { CommandHandler } from './command-handler.js';
import { print } from '../utils/render.js';

export const gatewayCommandHandler: CommandHandler = {
  name: 'gateway',
  commands: ['gateway'],
  canHandle(context: CliContext): boolean {
    return context.args.command === 'gateway';
  },
  async handle(context: CliContext): Promise<boolean> {
    const { subcommand } = context.args;
    switch (subcommand) {
      case 'start':
        return gatewayStart(context);
      case 'stop':
        return gatewayStop(context);
      case 'status':
        return gatewayStatusCmd(context);
      default:
        throw new Error('Usage: memphis gateway <start|stop|status>');
    }
  },
};

// ── Gateway state stored at module level — shared when Memphis runs in-process (npm run dev) ──

async function gatewayStart(context: CliContext): Promise<boolean> {
  const { json } = context.args;

  const { gatewayStatus, startGateway } = await import('../../../app/bootstrap.js');

  const status = gatewayStatus();
  if (status.running) {
    print({ ok: false, message: 'Gateway already running' }, json);
    return true;
  }

  try {
    await startGateway();
    print({ ok: true, message: 'Gateway started' }, json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    print({ ok: false, error: msg }, json);
  }
  return true;
}

async function gatewayStop(context: CliContext): Promise<boolean> {
  const { json } = context.args;

  const { stopGateway, gatewayStatus } = await import('../../../app/bootstrap.js');

  const status = gatewayStatus();
  if (!status.running) {
    print({ ok: false, message: 'Gateway not running' }, json);
    return true;
  }

  await stopGateway();
  print({ ok: true, message: 'Gateway stopped' }, json);
  return true;
}

async function gatewayStatusCmd(context: CliContext): Promise<boolean> {
  const { json } = context.args;

  const { gatewayStatus } = await import('../../../app/bootstrap.js');
  const status = gatewayStatus();

  if (json) {
    print({ ok: true, running: status.running }, json);
  } else {
    console.log(`Channel gateway: ${status.running ? 'running' : 'stopped'}`);
    if (!status.running) {
      console.log('Start with: memphis gateway start');
    }
  }
  return true;
}
