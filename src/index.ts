import { bootstrap } from './app/bootstrap.js';
import { resolveExitCode } from './infra/runtime/exit-codes.js';

bootstrap().catch((error) => {
  console.error('Bootstrap failed', error);
  process.exit(resolveExitCode(error));
});
