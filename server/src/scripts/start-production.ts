import { applyProductionMigrations } from './migrationStartup.js';

async function start() {
  if (process.env.NODE_ENV === 'production') {
    applyProductionMigrations();
    console.log(JSON.stringify({ event: 'database_migrations_completed' }));
  }

  await import('../server.js');
}

void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Application startup failed.';
  console.error(JSON.stringify({ event: 'server_start_failed', message }));
  process.exitCode = 1;
});
