import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { Redis } from 'ioredis';
import { config } from '../config.js';
import { verifyAccessToken } from '../middleware/auth.js';

/**
 * Real-time updates. Each authenticated socket joins room `user:<id>`.
 * Other processes (BullMQ workers) publish to the Redis channel
 * REALTIME_CHANNEL and the API process relays those messages to sockets.
 */
export const REALTIME_CHANNEL = 'smart-scheduling:realtime';

export type RealtimeEvent =
  | 'schedule:updated'
  | 'task:updated'
  | 'notification:new'
  | 'calendar:updated';

let io: Server | null = null;
let publisher: Redis | null = null;

export function initRealtime(server: HttpServer): Server {
  io = new Server(server, { cors: { origin: config.corsOrigin, credentials: true } });
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error('unauthorized'));
    try {
      socket.data.user = verifyAccessToken(token);
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.user.id}`);
  });

  if (config.redisUrl) {
    const sub = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    sub.on('error', (e) => console.warn('[realtime] redis subscriber error:', e.message));
    sub.subscribe(REALTIME_CHANNEL).catch(() => undefined);
    sub.on('message', (_channel, raw) => {
      try {
        const { userId, event, payload } = JSON.parse(raw);
        io?.to(`user:${userId}`).emit(event, payload);
      } catch {
        /* ignore malformed */
      }
    });
  }
  return io;
}

/** Emits to a user's sockets — directly if in the API process, else via Redis. */
export function emitToUser(userId: string, event: RealtimeEvent, payload: unknown = {}): void {
  if (io) {
    io.to(`user:${userId}`).emit(event, payload);
    return;
  }
  if (config.redisUrl) {
    publisher ??= new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    publisher.publish(REALTIME_CHANNEL, JSON.stringify({ userId, event, payload })).catch(() => undefined);
  }
}

export async function closeRealtime(): Promise<void> {
  await publisher?.quit().catch(() => undefined);
  publisher = null;
  await new Promise<void>((r) => (io ? io.close(() => r()) : r()));
  io = null;
}
