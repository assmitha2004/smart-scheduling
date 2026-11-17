/**
 * AES-256-GCM encryption for OAuth refresh tokens at rest.
 * Format: v1.<iv>.<tag>.<ciphertext> (base64url parts).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../../config.js';

function key(): Buffer {
  const raw = config.tokenEncryptionKey;
  if (raw) {
    const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (k.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)');
    return k;
  }
  if (config.nodeEnv === 'production' && config.google.clientId) {
    throw new Error('Set TOKEN_ENCRYPTION_KEY to store Google tokens in production');
  }
  // Development / tests: derived from the JWT secret so it is stable across restarts.
  return createHash('sha256').update(`token-key:${config.jwtSecret}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(enc: string): string {
  const [v, iv, tag, ct] = enc.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised secret format');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}
