import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const mocks = vi.hoisted(() => {
  class DatabaseUnavailableError extends Error {
    statusCode = 503;

    constructor() {
      super('PostgreSQL is required in production and is unavailable.');
      this.name = 'DatabaseUnavailableError';
    }
  }

  return {
    isDatabaseAvailable: vi.fn(),
    DatabaseUnavailableError,
  };
});

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    session: { findFirst: vi.fn() },
    user: { findUnique: vi.fn() },
  },
  isDatabaseAvailable: mocks.isDatabaseAvailable,
  DatabaseUnavailableError: mocks.DatabaseUnavailableError,
}));

import { errorHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import { signAccessToken } from '../lib/auth.js';

function protectedApp() {
  const app = express();
  app.get('/protected', requireAuth, (_req, res) => res.sendStatus(204));
  app.use(errorHandler);
  return app;
}

describe('authentication during database outages', () => {
  beforeEach(() => {
    mocks.isDatabaseAvailable.mockReset();
  });

  it('returns a service-unavailable error instead of invalidating a valid session', async () => {
    mocks.isDatabaseAvailable.mockRejectedValue(new mocks.DatabaseUnavailableError());
    const token = signAccessToken({ sub: 'user_1', role: 'USER' });

    const response = await request(protectedApp())
      .get('/protected')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(503);
    expect(response.body.message).toBe('The database is temporarily unavailable.');
  });

  it('still rejects an invalid token before accessing the database', async () => {
    const response = await request(protectedApp())
      .get('/protected')
      .set('Authorization', 'Bearer invalid.token.value');

    expect(response.status).toBe(401);
    expect(response.body.message).toBe('Invalid or expired token.');
    expect(mocks.isDatabaseAvailable).not.toHaveBeenCalled();
  });

  it('classifies Prisma closed-connection errors as service unavailable', async () => {
    const app = express();
    app.get('/closed-connection', (_req, _res, next) => {
      next(new Error('Error in PostgreSQL connection: Error { kind: Closed, cause: None }'));
    });
    app.use(errorHandler);

    const response = await request(app).get('/closed-connection');

    expect(response.status).toBe(503);
    expect(response.body.message).toBe('The database is temporarily unavailable.');
  });
});
