import type { Prisma } from '@prisma/client';
import { prisma } from '../../db.js';

type Tx = Prisma.TransactionClient | typeof prisma;

/** Append-only audit trail of important changes. */
export async function logActivity(
  entry: {
    workspaceId?: string | null;
    actorId: string;
    entityType: string;
    entityId: string;
    action: string;
    metadata?: Prisma.InputJsonValue;
  },
  tx: Tx = prisma,
): Promise<void> {
  await tx.activityLog.create({
    data: {
      workspaceId: entry.workspaceId ?? null,
      actorId: entry.actorId,
      entityType: entry.entityType,
      entityId: entry.entityId,
      action: entry.action,
      metadata: entry.metadata ?? {},
    },
  });
}
