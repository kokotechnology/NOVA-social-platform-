import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyProductionMigrations } from '../scripts/migrationStartup.js';

const originalDatabaseUrl = process.env.DATABASE_URL;
const runtimeUrl = 'postgresql://runtime-user:runtime-password@ep-small-water-pooler.c-2.eu-west-2.aws.neon.tech/neondb?schema=public';
const secretUrl = 'postgresql://secret-user:secret-password@ep-small-water.c-2.eu-west-2.aws.neon.tech/neondb?schema=public';
const migrationUrl = 'postgresql://migrator-user:migrator-password@ep-small-water.c-2.eu-west-2.aws.neon.tech/neondb?schema=public';

afterEach(() => {
  vi.restoreAllMocks();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function dependencies(overrides: {
  run?: (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; encoding: 'utf8'; stdio: 'pipe' }) => {
    error?: Error;
    status: number | null;
    stdout?: string | null;
    stderr?: string | null;
  };
  verifyTables?: (databaseUrl: string) => Promise<string[]>;
} = {}) {
  return {
    readSecret: vi.fn((path: string) => path.endsWith('migration_database_url')
      ? `${migrationUrl}\n`
      : `${secretUrl}\n`),
    run: vi.fn(overrides.run ?? (() => ({ status: 0 }))),
    verifyTables: vi.fn(overrides.verifyTables ?? (async () => [])),
  };
}

describe('production migration startup', () => {
  it('checks database identity, deploys and verifies migration status before checking tables', async () => {
    process.env.DATABASE_URL = runtimeUrl;
    const deps = dependencies();

    await applyProductionMigrations(deps);

    expect(deps.readSecret).toHaveBeenCalledWith('/etc/secrets/database_url');
    expect(deps.readSecret).toHaveBeenCalledWith('/etc/secrets/migration_database_url');
    expect(deps.run).toHaveBeenCalledTimes(2);
    expect(deps.run).toHaveBeenNthCalledWith(
      1,
      'npx',
      ['prisma', 'migrate', 'deploy'],
      expect.objectContaining({
        env: expect.objectContaining({ DATABASE_URL: migrationUrl }),
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    );
    expect(deps.run).toHaveBeenNthCalledWith(
      2,
      'npx',
      ['prisma', 'migrate', 'status'],
      expect.objectContaining({
        env: expect.objectContaining({ DATABASE_URL: migrationUrl }),
        stdio: 'pipe',
      }),
    );
    expect(deps.verifyTables).toHaveBeenCalledWith(runtimeUrl);
    expect(process.env.DATABASE_URL).toBe(runtimeUrl);
  });

  it('aborts before migrating when configured database identities differ without exposing credentials', async () => {
    process.env.DATABASE_URL = 'postgresql://runtime-user:runtime-password@other-project.neon.tech/neondb?schema=public';
    const deps = dependencies();

    await expect(applyProductionMigrations(deps)).rejects.toThrow(
      'runtime DATABASE_URL=other-project.neon.tech/neondb?schema=public',
    );
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.verifyTables).not.toHaveBeenCalled();
  });

  it('aborts with a sanitized error when migration deploy fails', async () => {
    process.env.DATABASE_URL = runtimeUrl;
    const deps = dependencies({ run: () => ({ status: 1 }) });

    await expect(applyProductionMigrations(deps)).rejects.toThrow(
      'Prisma migrate deploy failed (exit code 1); application startup aborted.',
    );
    expect(deps.verifyTables).not.toHaveBeenCalled();
  });

  it('aborts if migrate status does not confirm the applied migrations', async () => {
    process.env.DATABASE_URL = runtimeUrl;
    const deps = dependencies({
      run: vi.fn()
        .mockReturnValueOnce({ status: 0 })
        .mockReturnValueOnce({ status: 1 }),
    });

    await expect(applyProductionMigrations(deps)).rejects.toThrow(
      'Prisma migrate status failed (exit code 1); application startup aborted.',
    );
    expect(deps.verifyTables).not.toHaveBeenCalled();
  });

  it('aborts when any Discussion Groups table is missing', async () => {
    process.env.DATABASE_URL = runtimeUrl;
    const deps = dependencies({ verifyTables: async () => ['DiscussionGroup', 'DiscussionGroupPostMedia'] });

    await expect(applyProductionMigrations(deps)).rejects.toThrow(
      'Database migration verification found missing required tables: DiscussionGroup, DiscussionGroupPostMedia; application startup aborted.',
    );
  });

  it('aborts when the persistent media storage table is missing', async () => {
    process.env.DATABASE_URL = runtimeUrl;
    const deps = dependencies({ verifyTables: async () => ['RegistrationMediaObject'] });

    await expect(applyProductionMigrations(deps)).rejects.toThrow(
      'Database migration verification found missing required tables: RegistrationMediaObject; application startup aborted.',
    );
  });

  it('redacts URLs from Prisma output', async () => {
    process.env.DATABASE_URL = runtimeUrl;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const deps = dependencies({ run: () => ({ status: 0, stdout: `${runtimeUrl}\n${migrationUrl}\n` }) });

    await applyProductionMigrations(deps);

    const loggedOutput = stdout.mock.calls.map(([value]) => String(value)).join('');
    expect(loggedOutput).not.toContain('runtime-password');
    expect(loggedOutput).not.toContain('secret-password');
    expect(loggedOutput).not.toContain('migrator-password');
    expect(loggedOutput).toContain('[REDACTED]');
  });

  it('aborts if the migration Secret File cannot be read', async () => {
    process.env.DATABASE_URL = runtimeUrl;
    const deps = dependencies();
    deps.readSecret.mockImplementation((path) => {
      if (path.endsWith('migration_database_url')) throw new Error('secret contents must not be logged');
      return secretUrl;
    });

    await expect(applyProductionMigrations(deps)).rejects.toThrow(
      'A required database Secret File is unavailable; application startup aborted.',
    );
    expect(deps.run).not.toHaveBeenCalled();
  });
});
