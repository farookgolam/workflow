import { createApp } from './app';
import { config } from './config';
import { closePool, getPool } from './db/pool';
import { startArchiveWorker } from './archive/worker';
import { startMailWorker } from './notifications/mailer';
import { startTenantPurge } from './platform/purge';
import { startSweeper } from './workflow/sweeper';

async function main() {
  await getPool(); // fail fast if the database is unreachable
  const server = createApp().listen(config.port, () => console.log(`API listening on ${config.port} (${config.env})`));

  const stopMail = startMailWorker();
  const stopArchive = startArchiveWorker();
  const stopSweeper = startSweeper();
  const stopPurge = startTenantPurge();

  const shutdown = () => {
    stopMail();
    stopArchive();
    stopSweeper();
    stopPurge();
    server.close(() => closePool().finally(() => process.exit(0)));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});
