import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyProductionMigrations } from '../scripts/migrationStartup.js';

const originalDatabaseUrl = process.env.DATABASE_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe('production migration startup', () => {
  it('uses the migration Secret File only for migrate deploy', () => {
    process.env.DATABASE_URL = 'postgresql://runtime.example/app';
    const readSecret = vi.fn(() => 'postgresql://migration.example/app\n');
    const run = vi.fn(() => ({ status: 0 }));

    applyProductionMigrations({ readSecret, run });

    expect(readSecret).toHaveBeenCalledWith('/etc/secrets/migration_database_url');
    expect(run).toHaveBeenCalledWith(
      'npx',
      ['prisma', 'migrate', 'deploy'],
      expect.objectContaining({
        env: expect.objectContaining({ DATABASE_URL: 'postgresql://migration.example/app' }),
        stdio: 'ignore',
      }),
    );
    expect(process.env.DATABASE_URL).toBe('postgresql://runtime.example/app');
  });

  it('aborts with a sanitized error when migrations fail', () => {
    const migrationUrl = 'postgresql://private-user:private-password@migration.example/app';
    let errorMessage: string | undefined;

    try {
      applyProductionMigrations({
        readSecret: () => migrationUrl,
        run: () => ({ status: 1 }),
      });
    } catch (error) {
      if (error instanceof Error) errorMessage = error.message;
    }

    expect(errorMessage).toBe('Prisma migrate deploy failed (exit code 1); application startup aborted.');
    expect(errorMessage).not.toContain(migrationUrl);
  });

  it('aborts if the migration Secret File cannot be read', () => {
    const run = vi.fn(() => ({ status: 0 }));

    expect(() => applyProductionMigrations({
      readSecret: () => { throw new Error('secret contents must not be logged'); },
      run,
    })).toThrow('Required migration Secret File is unavailable at /etc/secrets/migration_database_url; application startup aborted.');
    expect(run).not.toHaveBeenCalled();
  });
});
