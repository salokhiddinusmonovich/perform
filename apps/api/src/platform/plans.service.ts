import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Plan, UpdatePlan } from '@puantaj/schemas';
import { AuditService, diff } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth.context';
import { conflict, notFound } from '../common/api-error';
import { PrismaService } from '../prisma/prisma.service';

export interface PlanView {
  id: string;
  name: string;
  /** Decimal string, soʻm */
  monthlyPrice: string;
  maxActiveWorkers: number;
  timesheetModule: boolean;
  isActive: boolean;
  /** Companies on this plan */
  companyCount: number;
}

/** Plans companies pay for (AGENTS.md: Platform admin). Platform-level: no company scope. */
@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<PlanView[]> {
    const plans = await this.prisma.plan.findMany({
      include: { _count: { select: { companies: true } } },
      orderBy: [{ isActive: 'desc' }, { monthlyPrice: 'asc' }, { name: 'asc' }],
    });
    return plans.map((p) => ({
      id: p.id,
      name: p.name,
      monthlyPrice: p.monthlyPrice.toString(),
      maxActiveWorkers: p.maxActiveWorkers,
      timesheetModule: p.timesheetModule,
      isActive: p.isActive,
      companyCount: p._count.companies,
    }));
  }

  async create(auth: AuthContext, input: Plan): Promise<{ id: string }> {
    return this.prisma.$transaction(async (tx) => {
      const plan = await tx.plan.create({ data: input }).catch(nameTaken);
      await this.audit.record({ action: 'plan.create', auth, entityType: 'Plan', entityId: plan.id, data: input }, tx);
      return { id: plan.id };
    });
  }

  /** Edits a plan (it applies to every company on it), or archives it or brings it back. */
  async update(auth: AuthContext, id: string, input: UpdatePlan): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const before = await tx.plan.findUnique({ where: { id } });
      if (!before) throw notFound('plan.notFound');
      await tx.plan.update({ where: { id }, data: input }).catch(nameTaken);
      await this.audit.record(
        {
          action: 'plan.update',
          auth,
          entityType: 'Plan',
          entityId: id,
          data: diff({ ...before, monthlyPrice: before.monthlyPrice.toString() }, input),
        },
        tx,
      );
    });
  }
}

function nameTaken(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') throw conflict('plan.nameTaken');
  throw error;
}
