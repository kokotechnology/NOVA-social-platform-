import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Prisma, PrismaClient } from '@prisma/client';

const runtimeSecretFile = '/etc/secrets/database_url';
const migrationSecretFile = '/etc/secrets/migration_database_url';
const requiredTables = [
  'DiscussionGroup',
  'DiscussionGroupMembership',
  'DiscussionGroupMembershipRequest',
  'DiscussionGroupInvitation',
  'DiscussionGroupPost',
  'DiscussionGroupPostMedia',
  'DiscussionGroupComment',
  'DiscussionGroupPostReaction',
  'DiscussionGroupCommentReaction',
  'DiscussionGroupPoll',
  'DiscussionGroupPollOption',
  'DiscussionGroupPollVote',
  'DiscussionGroupBan',
  'DiscussionGroupReport',
  'DiscussionGroupModerationAction',
  'RegistrationMediaObject',
];

type DatabaseIdentity = {
  host: string;
  database: string;
  schema: string;
};

type MigrationStartupDependencies = {
  readSecret(path: string): string;
  run(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; encoding: 'utf8'; stdio: 'pipe' },
  ): { error?: Error; status: number | null; stdout?: string | null; stderr?: string | null };
  verifyTables(databaseUrl: string): Promise<string[]>;
};

function databaseIdentity(databaseUrl: string): DatabaseIdentity {
  const parsed = new URL(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw new Error();

  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  if (!parsed.hostname || !database) throw new Error();

  return {
    host: parsed.hostname.replace(/-pooler(?=\.|$)/i, '').toLowerCase(),
    database,
    schema: parsed.searchParams.get('schema') || 'public',
  };
}

function formatIdentity(identity: DatabaseIdentity) {
  return `${identity.host}/${identity.database}?schema=${identity.schema}`;
}

function assertSameDatabase(configurations: Array<{ name: string; url: string }>) {
  let identities: Array<{ name: string; identity: DatabaseIdentity }>;
  try {
    identities = configurations.map(({ name, url }) => ({ name, identity: databaseIdentity(url) }));
  } catch {
    throw new Error('A database URL has an invalid PostgreSQL identity; application startup aborted.');
  }

  const expected = identities[0].identity;
  if (identities.some(({ identity }) =>
    identity.host !== expected.host
    || identity.database !== expected.database
    || identity.schema !== expected.schema,
  )) {
    const details = identities.map(({ name, identity }) => `${name}=${formatIdentity(identity)}`).join(', ');
    throw new Error(`Database configuration mismatch (${details}); all URLs must target the same host/project, database, and schema. Application startup aborted.`);
  }
}

async function verifyDiscussionGroupTables(databaseUrl: string) {
  const client = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    const existing = await client.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name IN (${Prisma.join(requiredTables)})
    `;
    const existingNames = new Set(existing.map(({ table_name }) => table_name));
    return requiredTables.filter((tableName) => !existingNames.has(tableName));
  } finally {
    await client.$disconnect();
  }
}

const defaultDependencies: MigrationStartupDependencies = {
  readSecret: (path) => readFileSync(path, 'utf8'),
  run: (command, args, options) => spawnSync(command, args, options),
  verifyTables: verifyDiscussionGroupTables,
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

function runPrismaCommand(
  dependencies: MigrationStartupDependencies,
  args: string[],
  migrationDatabaseUrl: string,
  secrets: string[],
  commandLabel: string,
) {
  let result: ReturnType<MigrationStartupDependencies['run']>;
  try {
    result = dependencies.run('npx', ['prisma', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: migrationDatabaseUrl },
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch {
    throw new Error(`Prisma ${commandLabel} could not start; application startup aborted.`);
  }

  writeSanitizedOutput(result.stdout, process.stdout, secrets);
  writeSanitizedOutput(result.stderr, process.stderr, secrets);

  if (result.error || result.status !== 0) {
    const status = result.status === null ? '' : ` (exit code ${result.status})`;
    throw new Error(`Prisma ${commandLabel} failed${status}; application startup aborted.`);
  }
}

export async function applyProductionMigrations(
  dependencies: MigrationStartupDependencies = defaultDependencies,
) {
  const runtimeDatabaseUrl = process.env.DATABASE_URL;
  if (!runtimeDatabaseUrl) {
    throw new Error('Runtime DATABASE_URL is unavailable; application startup aborted.');
  }

  let runtimeSecretUrl: string;
  let migrationDatabaseUrl: string;
  try {
    runtimeSecretUrl = dependencies.readSecret(runtimeSecretFile).trim();
    migrationDatabaseUrl = dependencies.readSecret(migrationSecretFile).trim();
  } catch {
    throw new Error('A required database Secret File is unavailable; application startup aborted.');
  }

  if (!runtimeSecretUrl || !migrationDatabaseUrl) {
    throw new Error('A required database Secret File is empty; application startup aborted.');
  }

  assertSameDatabase([
    { name: 'runtime DATABASE_URL', url: runtimeDatabaseUrl },
    { name: 'database_url Secret File', url: runtimeSecretUrl },
    { name: 'migration_database_url Secret File', url: migrationDatabaseUrl },
  ]);

  const secrets = [runtimeDatabaseUrl, runtimeSecretUrl, migrationDatabaseUrl];
  runPrismaCommand(dependencies, ['migrate', 'deploy'], migrationDatabaseUrl, secrets, 'migrate deploy');
  runPrismaCommand(dependencies, ['migrate', 'status'], migrationDatabaseUrl, secrets, 'migrate status');

  let missingTables: string[];
  try {
    missingTables = await dependencies.verifyTables(runtimeDatabaseUrl);
  } catch {
    throw new Error('Database migration verification failed; application startup aborted.');
  }
  if (missingTables.length) {
    throw new Error(`Database migration verification found missing required tables: ${missingTables.join(', ')}; application startup aborted.`);
  }
}
