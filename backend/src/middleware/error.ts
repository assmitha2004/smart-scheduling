import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '../utils/errors.js';
import { config } from '../config.js';

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
}

/** True when Postgres rejected overlapping confirmed blocks (exclusion constraint). */
export function isOverlapViolation(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('scheduled_blocks_no_overlap') || msg.includes('23P01');
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (isOverlapViolation(err)) {
    res.status(409).json({
      error: { code: 'SCHEDULE_CONFLICT', message: 'Two scheduled blocks would overlap. Refresh and try again.' },
    });
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with these values already exists.' } });
      return;
    }
    if (err.code === 'P2025') {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
      return;
    }
  }
  if (err instanceof SyntaxError && 'body' in (err as object)) {
    res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON body' } });
    return;
  }
  if (!config.isTest) console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
}
