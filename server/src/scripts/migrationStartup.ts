import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const migrationSecretFile = '/etc/secrets/migration_database_url';

type MigrationStartupDependencies = {
  readSecret(path: string): string;
  run(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; encoding: 'utf8'; stdio: 'pipe' },
  ): { error?: Error; status: number | null; stdout?: string | null; stderr?: string | null };
};

const defaultDependencies: MigrationStartupDependencies = {
  readSecret: (path) => readFileSync(path, 'utf8'),
  run: (command, args, options) => spawnSync(command, args, options),
};

function writeSanitizedOutput(output: string | null | undefined, stream: NodeJS.WriteStream, secrets: string[]) {
  if (!output) return;

  let sanitized = output;
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join('[REDACTED]');
  }
  sanitized = sanitized.replace(/(postgres(?:ql)?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@');
  stream.write(sanitized);
}

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

  let result: { error?: Error; status: number | null; stdout?: string | null; stderr?: string | null };
  try {
    result = dependencies.run('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: migrationDatabaseUrl },
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch {
    throw new Error('Prisma migrate deploy could not start; application startup aborted.');
  }

  const secrets = [migrationDatabaseUrl, process.env.DATABASE_URL].filter((value): value is string => Boolean(value));
  writeSanitizedOutput(result.stdout, process.stdout, secrets);
  writeSanitizedOutput(result.stderr, process.stderr, secrets);

  if (result.error || result.status !== 0) {
    const status = result.status === null ? '' : ` (exit code ${result.status})`;
    throw new Error(`Prisma migrate deploy failed${status}; application startup aborted.`);
  }
}
