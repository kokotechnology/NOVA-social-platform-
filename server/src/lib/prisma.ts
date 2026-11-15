import { PrismaClient } from '@prisma/client';
import env from '../config/env.js';

const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient;
};

export class DatabaseUnavailableError extends Error {
  statusCode = 503;

  constructor() {
    super('PostgreSQL is required in production and is unavailable.');
    this.name = 'DatabaseUnavailableError';
  }
}

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  datasourceUrl: env.DATABASE_URL,
  log: env.NODE_ENV === 'development' ? ['query', 'warn', 'error'] : ['warn', 'error'],
});

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export async function isDatabaseAvailable() {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
    return false;
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    if (env.NODE_ENV === 'production') {
      throw new DatabaseUnavailableError();
    }

    return false;
  }
}
