import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AUDIT_PAGE_SIZE, LOGIN_ACTION, type AuditQuery } from '@puantaj/schemas';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntryView {
  id: string;
  createdAt: Date;
  /** An `AuditAction`, or an older code the app no longer records */
  action: string;
  company: { id: string; name: string } | null;
  /** Who did it; null for actions without a session (e.g. the CLI) */
  actor: { id: string; fullName: string } | null;
  /** The platform admin who acted as `actor` (impersonation) */
  impersonator: { id: string; fullName: string } | null;
  entityType: string | null;
  entityId: string | null;
  /** Changed fields ({ field: { from, to } }) or other details; never passwords */
  data: Prisma.JsonValue;
  ip: string | null;
}

export interface AuditPage {
  entries: AuditEntryView[];
  /** Pass as `before` for the next (older) page; null when this is the last one */
  nextCursor: string | null;
}

const person = { select: { id: true, fullName: true } } as const;

/** The platform admin's read-only view of the audit trail (AGENTS.md: Platform admin). */
@Injectable()
export class PlatformAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AuditQuery): Promise<AuditPage> {
    const where: Prisma.AuditLogWhereInput[] = [];
    if (query.companyId) where.push({ companyId: query.companyId });
    if (query.userId) {
      where.push({
        OR: [
          { actorUserId: query.userId },
          { impersonatorUserId: query.userId },
          { entityType: 'User', entityId: query.userId },
        ],
      });
    }
    if (query.area) {
      where.push({ action: { startsWith: `${query.area}.` } });
    }
    if (!query.logins) where.push({ action: { not: LOGIN_ACTION } });
    if (query.from) where.push({ createdAt: { gte: new Date(query.from) } });
    if (query.to) where.push({ createdAt: { lt: new Date(query.to) } });
    if (query.before) {
      const [at, id] = query.before.split('_') as [string, string];
      const createdAt = new Date(at);
      where.push({ OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }] });
    }

    const rows = await this.prisma.auditLog.findMany({
      where: { AND: where },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: AUDIT_PAGE_SIZE + 1,
      include: { company: { select: { id: true, name: true } }, actor: person, impersonator: person },
    });
    const page = rows.slice(0, AUDIT_PAGE_SIZE);
    const last = page.at(-1);
    return {
      entries: page.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        action: r.action,
        company: r.company,
        actor: r.actor,
        impersonator: r.impersonator,
        entityType: r.entityType,
        entityId: r.entityId,
        data: r.data,
        ip: r.ip,
      })),
      nextCursor: rows.length > AUDIT_PAGE_SIZE && last ? `${last.createdAt.toISOString()}_${last.id}` : null,
    };
  }
}
