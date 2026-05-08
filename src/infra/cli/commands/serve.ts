/* eslint-disable no-restricted-syntax */
//
// rawEnv-threading default parameter or single-call config-source
// pattern. File-level disable per Sprint ι policy — accessor would
// add registry weight without consumer benefit.
//
import { bootstrap } from '../../../app/bootstrap.js';

export async function serveCommand(telegram?: boolean) {
  if (telegram) {
    process.env.MEMPHIS_CHANNEL_GATEWAY_ENABLED = 'true';
  }
  await bootstrap();
}
