import { Router } from 'express';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { prisma } from '../../db.js';
import { config } from '../../config.js';
import { parse } from '../../middleware/validate.js';
import { signAccessToken } from '../../middleware/auth.js';
import { conflict, unauthorized } from '../../utils/errors.js';
import { isValidTimezone } from '../../utils/time.js';
import { serializeUser } from '../users/users.routes.js';

export const authRouter = Router();

const limiter = rateLimit({ windowMs: 15 * 60_000, limit: config.isTest ? 10_000 : 50, standardHeaders: 'draft-8', legacyHeaders: false });

const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  timezone: z.string().refine(isValidTimezone, 'Unknown timezone').optional(),
});
const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) });
const refreshSchema = z.object({ refreshToken: z.string().min(10) });

const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

async function issueTokens(user: { id: string; email: string }) {
  const refreshToken = crypto.randomBytes(48).toString('base64url');
  await prisma.refreshToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + config.refreshTokenTtlDays * 86_400_000),
    },
  });
  return { accessToken: signAccessToken(user), refreshToken, expiresIn: config.accessTokenTtlSeconds };
}

authRouter.post('/register', limiter, async (req, res) => {
  const body = parse(registerSchema, req.body);
  const existing = await prisma.user.findUnique({ where: { email: body.email } });
  if (existing) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
  const passwordHash = await bcrypt.hash(body.password, 10);
  // Every user gets a personal workspace they own.
  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: { name: body.name, email: body.email, passwordHash, timezone: body.timezone ?? 'UTC' },
    });
    const ws = await tx.workspace.create({ data: { name: `${body.name.split(' ')[0]}'s workspace`, ownerId: u.id } });
    await tx.workspaceMember.create({ data: { workspaceId: ws.id, userId: u.id, role: 'OWNER' } });
    return u;
  });
  res.status(201).json({ user: serializeUser(user), ...(await issueTokens(user)) });
});

authRouter.post('/login', limiter, async (req, res) => {
  const body = parse(loginSchema, req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  // Constant-ish time: always run bcrypt.
  const ok = await bcrypt.compare(body.password, user?.passwordHash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinv');
  if (!user || !ok) throw unauthorized('Invalid email or password');
  res.json({ user: serializeUser(user), ...(await issueTokens(user)) });
});

/** Rotates refresh tokens: each refresh token can be used exactly once. */
authRouter.post('/refresh', limiter, async (req, res) => {
  const { refreshToken } = parse(refreshSchema, req.body);
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(refreshToken) }, include: { user: true } });
  if (!row || row.revokedAt || row.expiresAt < new Date()) throw unauthorized('Invalid refresh token');
  const revoked = await prisma.refreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date() } });
  if (!revoked.count) throw unauthorized('Invalid refresh token');
  res.json({ user: serializeUser(row.user), ...(await issueTokens(row.user)) });
});

authRouter.post('/logout', async (req, res) => {
  const r = refreshSchema.safeParse(req.body);
  if (r.success) {
    await prisma.refreshToken.updateMany({ where: { tokenHash: hashToken(r.data.refreshToken), revokedAt: null }, data: { revokedAt: new Date() } });
  }
  res.status(204).end();
});
