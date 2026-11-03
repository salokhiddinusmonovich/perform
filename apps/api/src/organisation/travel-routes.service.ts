import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TravelRoute, UpdateTravelRoute } from '@puantaj/schemas';
import { AuditService } from '../audit/audit.service';
import type { CompanyAuthContext } from '../auth/auth.context';
import { conflict, notFound } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';

export interface TravelRouteView {
  id: string;
  name: string;
  amountPerDay: string;
  isActive: boolean;
  /** A placement has had it, so its amount is fixed (travelRoute.inUse) */
  inUse: boolean;
}

type Tx = Prisma.TransactionClient;

/**
 * Travel routes (AGENTS.md: Travel pay): a route workers travel to a site, with its pay per
 * day worked. Owners and admins define them; a route's amount is fixed once a placement has
 * had it, since a change would reach months already paid. A new amount is a new route.
 */
@Injectable()
export class TravelRoutesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(auth: CompanyAuthContext): Promise<TravelRouteView[]> {
    const rows = await this.prisma.travelRoute.findMany({
      where: { companyId: auth.company.id },
      include: { _count: { select: { assignments: true } } },
      orderBy: { name: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      amountPerDay: r.amountPerDay.toString(),
      isActive: r.isActive,
      inUse: r._count.assignments > 0,
    }));
  }

  async create(auth: CompanyAuthContext, input: TravelRoute): Promise<{ id: string }> {
    const companyId = auth.company.id;
    return this.prisma.$transaction(async (tx) => {
      await this.assertNameFree(tx, companyId, input.name, null);
      const route = await tx.travelRoute.create({ data: { companyId, ...input } });
      await this.record(tx, auth, 'travelRoute.create', route.id, { ...input });
      return { id: route.id };
    });
  }

  async update(auth: CompanyAuthContext, id: string, input: UpdateTravelRoute): Promise<void> {
    const companyId = auth.company.id;
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.travelRoute.findFirst({ where: { id, companyId } });
      if (!before) throw notFound('travelRoute.notFound');
      if (input.name !== undefined) await this.assertNameFree(tx, companyId, input.name, id);
      const amountChange = input.amountPerDay !== undefined && !before.amountPerDay.equals(input.amountPerDay);
      if (amountChange && (await tx.assignment.count({ where: { travelRouteId: id } })) > 0) {
        throw conflict('travelRoute.inUse');
      }
      await tx.travelRoute.update({ where: { id }, data: input });
      const old = { name: before.name, amountPerDay: before.amountPerDay.toString(), isActive: before.isActive };
      const changes = (Object.keys(input) as (keyof UpdateTravelRoute)[]).filter((k) => input[k] !== undefined);
      await this.record(tx, auth, 'travelRoute.update', id, {
        changes: Object.fromEntries(changes.map((k) => [k, { from: old[k], to: input[k] }])),
      });
    });
  }

  private async assertNameFree(tx: Tx, companyId: string, name: string, exceptId: string | null) {
    const other = await tx.travelRoute.findFirst({
      where: { companyId, name: { equals: name, mode: 'insensitive' }, NOT: exceptId ? { id: exceptId } : undefined },
    });
    if (other) throw conflict('travelRoute.nameTaken');
  }

  private record(tx: Tx, auth: CompanyAuthContext, action: string, id: string, data: Prisma.InputJsonObject) {
    return this.audit.record(
      { action, companyId: auth.company.id, auth, entityType: 'TravelRoute', entityId: id, data },
      tx,
    );
  }
}

/**
 * A route a placement can be given: this company's and active, unless it is the one the
 * placement already has. null: no route.
 */
export async function findTravelRoute(tx: Tx, companyId: string, id: string | null, current: string | null = null) {
  if (id === null) return null;
  const route = await tx.travelRoute.findFirst({ where: { id, companyId } });
  if (!route) throw notFound('travelRoute.notFound');
  if (!route.isActive && id !== current) throw conflict('travelRoute.inactive');
  return route;
}
