import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const migrationSecretFile = '/etc/secrets/migration_database_url';

type MigrationStartupDependencies = {
  readSecret(path: string): string;
  run(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; stdio: 'ignore' },
  ): { error?: Error; status: number | null };
};

const defaultDependencies: MigrationStartupDependencies = {
  readSecret: (path) => readFileSync(path, 'utf8'),
  run: (command, args, options) => spawnSync(command, args, options),
};

export function applyProductionMigrations(
  dependencies: MigrationStartupDependencies = defaultDependencies,
) {
  let migrationDatabaseUrl: string;
  try {
    migrationDatabaseUrl = dependencies.readSecret(migrationSecretFile).trim();
  } catch {
    throw new Error(
      `Required migration Secret File is unavailable at ${migrationSecretFile}; application startup aborted.`,
    );
  }

  if (!migrationDatabaseUrl) {
    throw new Error(
      `Required migration Secret File is empty at ${migrationSecretFile}; application startup aborted.`,
    );
  }

  let result: { error?: Error; status: number | null };
  try {
    result = dependencies.run('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: migrationDatabaseUrl },
      stdio: 'ignore',
    });
  } catch {
    throw new Error('Prisma migrate deploy could not start; application startup aborted.');
  }

  if (result.error || result.status !== 0) {
    const status = result.status === null ? '' : ` (exit code ${result.status})`;
    throw new Error(`Prisma migrate deploy failed${status}; application startup aborted.`);
  }
}
