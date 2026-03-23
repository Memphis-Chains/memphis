import { bootstrap } from './app/bootstrap.js';
import { writeEmergencyLog } from './infra/runtime/emergency-log.js';
import { resolveExitCode } from './infra/runtime/exit-codes.js';

bootstrap().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  writeEmergencyLog(`BOOTSTRAP_CRASH: ${message}`);
  console.error('Bootstrap failed', error);
  process.exit(resolveExitCode(error));
});
