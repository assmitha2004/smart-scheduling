import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { unauthorized } from '../utils/errors.js';

export interface AuthUser {
  id: string;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function signAccessToken(user: AuthUser): string {
  return jwt.sign({ sub: user.id, email: user.email, typ: 'access' }, config.jwtSecret, {
    expiresIn: config.accessTokenTtlSeconds,
  });
}

export function verifyAccessToken(token: string): AuthUser {
  const payload = jwt.verify(token, config.jwtSecret) as jwt.JwtPayload;
  if (payload.typ !== 'access' || typeof payload.sub !== 'string') throw new Error('Invalid token type');
  return { id: payload.sub, email: String(payload.email) };
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(unauthorized());
  try {
    req.user = verifyAccessToken(header.slice(7));
    next();
  } catch {
    next(unauthorized('Invalid or expired access token'));
  }
}

/** Use inside handlers after requireAuth. */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}
