import { bootstrap } from '../../../app/bootstrap.js';

export async function serveCommand(telegram?: boolean) {
  if (telegram) {
    process.env.MEMPHIS_CHANNEL_GATEWAY_ENABLED = 'true';
  }
  await bootstrap();
}
