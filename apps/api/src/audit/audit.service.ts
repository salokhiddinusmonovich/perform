import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuthContext } from '../auth/auth.context';
import { PrismaService } from '../prisma/prisma.service';

interface AuditDetails {
  action: string;
  companyId?: string | null;
  entityType?: string;
  entityId?: string;
  /** Changed fields or other details. Never put passwords or tokens here. */
  data?: Prisma.InputJsonObject;
}

/**
 * A logged-in action passes `auth`: the entry then records the user, the platform admin
 * acting as them (impersonation) and the IP. Only actions without a session (login, CLI)
 * name the actor themselves.
 */
export type AuditEntry = AuditDetails &
  (
    | { auth: Pick<AuthContext, 'user' | 'impersonator' | 'ip'> }
    | { auth?: undefined; actorUserId?: string | null; ip?: string | null }
  );

type Db = Pick<Prisma.TransactionClient, 'auditLog'>;

/** Append-only record of who changed what (AGENTS.md: audit trail). */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass the transaction client so the audit row commits or rolls back with the change. */
  async record(entry: AuditEntry, db: Db = this.prisma): Promise<void> {
    const { auth } = entry;
    await db.auditLog.create({
      data: {
        action: entry.action,
        companyId: entry.companyId ?? null,
        actorUserId: auth ? auth.user.id : (entry.actorUserId ?? null),
        impersonatorUserId: auth?.impersonator?.id ?? null,
        entityType: entry.entityType,
        entityId: entry.entityId,
        data: entry.data ?? {},
        ip: auth ? auth.ip : (entry.ip ?? null),
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
