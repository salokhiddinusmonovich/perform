import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  action: string;
  companyId?: string | null;
  actorUserId?: string | null;
  entityType?: string;
  entityId?: string;
  /** Changed fields or other details. Never put passwords or tokens here. */
  data?: Prisma.InputJsonObject;
  ip?: string | null;
}

type Db = Pick<Prisma.TransactionClient, 'auditLog'>;

/** Append-only record of who changed what (AGENTS.md: audit trail). */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass the transaction client so the audit row commits or rolls back with the change. */
  async record(entry: AuditEntry, db: Db = this.prisma): Promise<void> {
    await db.auditLog.create({
      data: {
        action: entry.action,
        companyId: entry.companyId ?? null,
        actorUserId: entry.actorUserId ?? null,
        entityType: entry.entityType,
        entityId: entry.entityId,
        data: entry.data ?? {},
        ip: entry.ip ?? null,
      },
    });
  }
}

/** Returns only the fields whose values differ, as { field: { from, to } }. */
export function diff<T extends Record<string, unknown>>(before: T, after: Partial<T>): Prisma.InputJsonObject {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (after[key] !== undefined && after[key] !== before[key]) {
      changes[key] = { from: before[key], to: after[key] };
    }
  }
  return changes as Prisma.InputJsonObject;
}
