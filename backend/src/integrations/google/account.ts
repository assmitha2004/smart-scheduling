/**
 * Connecting a Google account (OAuth 2.0 authorization-code flow with offline
 * access) and getting a short-lived access token for it.
 *
 * - The OAuth `state` is a signed, 10-minute JWT naming the user, so the
 *   callback can't be replayed for someone else.
 * - Only the refresh token is stored, encrypted. Access tokens live in memory
 *   until shortly before they expire.
 * - A revoked grant marks the account NEEDS_RECONNECT instead of failing forever.
 */
import jwt from 'jsonwebtoken';
import type { GoogleAccount } from '@prisma/client';
import { config } from '../../config.js';
import { prisma } from '../../db.js';
import { badRequest, serviceUnavailable } from '../../utils/errors.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { DEMO_EMAIL } from './demo.js';
import { GoogleAuthError } from './types.js';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
];

export const googleConfigured = () => !!(config.google.clientId && config.google.clientSecret);
export const redirectUri = () => config.google.redirectUri ?? `${config.appUrl.replace(/\/$/, '')}/api/v1/integrations/google/callback`;

export function buildAuthUrl(userId: string): string {
  if (!googleConfigured()) throw serviceUnavailable('GOOGLE_NOT_CONFIGURED', 'Google sign-in is not set up on this server. Try the sample inbox instead.');
  const state = jwt.sign({ sub: userId, purpose: 'google-oauth' }, config.jwtSecret, { expiresIn: '10m' });
  const q = new URLSearchParams({
    client_id: config.google.clientId!,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

export function verifyState(state: string): string {
  try {
    const p = jwt.verify(state, config.jwtSecret) as { sub?: string; purpose?: string };
    if (p.purpose !== 'google-oauth' || !p.sub) throw new Error('wrong purpose');
    return p.sub;
  } catch {
    throw badRequest('The Google sign-in link expired. Please try connecting again.');
  }
}

async function tokenRequest(params: Record<string, string>) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.google.clientId!, client_secret: config.google.clientSecret!, ...params }),
    signal: AbortSignal.timeout(15000),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; id_token?: string; error?: string };
  return { ok: res.ok, data };
}

/** Exchanges the callback code, stores the encrypted refresh token and returns the account email. */
export async function completeConnect(userId: string, code: string): Promise<string> {
  const { ok, data } = await tokenRequest({ code, redirect_uri: redirectUri(), grant_type: 'authorization_code' });
  if (!ok || !data.access_token) throw badRequest(`Google sign-in failed (${data.error ?? 'no token'})`);
  if (!data.refresh_token) throw badRequest('Google did not return offline access. Remove the app from your Google account permissions and connect again.');
  const granted = new Set((data.scope ?? '').split(' '));
  const missing = GOOGLE_SCOPES.filter((s) => s.startsWith('https://') && !granted.has(s));
  if (missing.length) throw badRequest('Please allow Calendar and Gmail access so the assistant can read invites and send replies you approve.');
  const info = (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${data.access_token}` } })
    .then((r) => r.json())
    .catch(() => ({}))) as { email?: string };
  const email = info.email ?? 'unknown';
  const row = { mode: 'google', email, refreshTokenEnc: encryptSecret(data.refresh_token), scopes: data.scope ?? '', status: 'CONNECTED' };
  await prisma.googleAccount.upsert({ where: { userId }, create: { userId, ...row }, update: row });
  cache.set(userId, { token: data.access_token, exp: Date.now() + ((data.expires_in ?? 3600) - 120) * 1000 });
  return email;
}

export async function connectDemo(userId: string) {
  const row = { mode: 'demo', email: DEMO_EMAIL, refreshTokenEnc: null, scopes: 'demo', status: 'CONNECTED' };
  return prisma.googleAccount.upsert({ where: { userId }, create: { userId, ...row }, update: row });
}

const cache = new Map<string, { token: string; exp: number }>();

/** A valid access token for a real Google account (refreshing it when needed). */
export async function accessTokenFor(account: GoogleAccount): Promise<string> {
  const hit = cache.get(account.userId);
  if (hit && hit.exp > Date.now()) return hit.token;
  if (!account.refreshTokenEnc || !googleConfigured()) throw new GoogleAuthError('Google account is not connected');
  const { ok, data } = await tokenRequest({ refresh_token: decryptSecret(account.refreshTokenEnc), grant_type: 'refresh_token' });
  if (!ok || !data.access_token) {
    if (data.error === 'invalid_grant') {
      await prisma.googleAccount.update({ where: { id: account.id }, data: { status: 'NEEDS_RECONNECT' } });
      throw new GoogleAuthError('Google access was revoked or expired. Please reconnect.');
    }
    throw new Error(`Could not refresh the Google token (${data.error ?? 'unknown error'})`);
  }
  cache.set(account.userId, { token: data.access_token, exp: Date.now() + ((data.expires_in ?? 3600) - 120) * 1000 });
  return data.access_token;
}

export async function disconnect(userId: string) {
  const account = await prisma.googleAccount.findUnique({ where: { userId } });
  if (!account) return;
  cache.delete(userId);
  if (account.mode === 'google' && account.refreshTokenEnc) {
    // Best effort: also revoke the grant at Google.
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decryptSecret(account.refreshTokenEnc))}`, { method: 'POST' }).catch(() => undefined);
  }
  await prisma.googleAccount.delete({ where: { userId } });
}

export async function markNeedsReconnect(userId: string) {
  cache.delete(userId);
  await prisma.googleAccount.updateMany({ where: { userId, mode: 'google' }, data: { status: 'NEEDS_RECONNECT' } });
}
