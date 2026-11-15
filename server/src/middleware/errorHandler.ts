import type { NextFunction, Request, Response } from 'express';
import env from '../config/env.js';
import { DatabaseUnavailableError } from '../lib/prisma.js';

function isDatabaseConnectionError(error: Error) {
  const connectionCodes = ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'];
  const hasConnectionCode = 'code' in error
    && typeof error.code === 'string'
    && connectionCodes.includes(error.code);
  const postgresConnectionClosed = /Error in PostgreSQL connection:\s*Error\s*\{\s*kind:\s*Closed,\s*cause:\s*None\s*\}/i.test(error.message);

  return error instanceof DatabaseUnavailableError || hasConnectionCode || postgresConnectionClosed;
}

export function errorHandler(error: Error, _req: Request, res: Response, _next: NextFunction) {
  const databaseUnavailable = isDatabaseConnectionError(error);
  const statusCode = databaseUnavailable
    ? 503
    : 'statusCode' in error && typeof (error as { statusCode?: number }).statusCode === 'number'
      ? Number((error as { statusCode?: number }).statusCode)
      : 500;

  const message = databaseUnavailable
    ? 'The database is temporarily unavailable.'
    : env.NODE_ENV === 'production' && statusCode >= 500
      ? 'An internal server error occurred.'
      : error.message || 'Internal server error';

  res.status(statusCode).json({ message });
}
