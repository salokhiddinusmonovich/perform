import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Plan, UpdatePlan } from '@puantaj/schemas';
import { AuditService, diff } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth.context';
import { conflict, notFound } from '../common/api-error';
import { monthOfDay, todayIn } from '../common/dates';
import { PrismaService } from '../prisma/prisma.service';
import { pendingPlan, planOfMonth, PLAN_HISTORY } from './company-plan';

export interface PlanView {
  id: string;
  name: string;
  /** Decimal string, soʻm */
  monthlyPrice: string;
  maxActiveWorkers: number;
  timesheetModule: boolean;
  isActive: boolean;
  /** Companies on this plan this month or from next month */
  companyCount: number;
  /** Some company has had it: its price, worker limit and modules are fixed */
  inUse: boolean;
}

/** Plans companies pay for (AGENTS.md: Platform admin). Platform-level: no company scope. */
@Injectable()
export class PlansService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<PlanView[]> {
    const [plans, companies] = await Promise.all([
      this.prisma.plan.findMany({
        include: { _count: { select: { companies: true } } },
        orderBy: [{ isActive: 'desc' }, { monthlyPrice: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.company.findMany({ select: { timezone: true, plans: PLAN_HISTORY } }),
    ]);
    const onPlan = new Map<string, number>();
    for (const c of companies) {
      const today = todayIn(c.timezone);
      const ids = new Set([planOfMonth(c.plans, monthOfDay(today))?.id, pendingPlan(c.plans, today)?.plan.id]);
      for (const planId of ids) if (planId) onPlan.set(planId, (onPlan.get(planId) ?? 0) + 1);
    }
    return plans.map((p) => ({
      id: p.id,
      name: p.name,
      monthlyPrice: p.monthlyPrice.toString(),
      maxActiveWorkers: p.maxActiveWorkers,
      timesheetModule: p.timesheetModule,
      isActive: p.isActive,
      companyCount: onPlan.get(p.id) ?? 0,
      inUse: p._count.companies > 0,
    }));
  }

  async create(auth: AuthContext, input: Plan): Promise<{ id: string }> {
    return this.prisma.$transaction(async (tx) => {
      const plan = await tx.plan.create({ data: input }).catch(nameTaken);
      await this.audit.record({ action: 'plan.create', auth, entityType: 'Plan', entityId: plan.id, data: input }, tx);
      return { id: plan.id };
    });
  }

  /**
   * Edits a plan, or archives it or brings it back. Once a company has had the plan, only
   * its name changes: new terms would change months that already started (each month has
   * one plan, AGENTS.md: Plans), so they go into a new plan that companies move to.
   */
  async update(auth: AuthContext, id: string, input: UpdatePlan): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Locked against a company being moved onto it meanwhile (offeredPlan).
      await tx.$queryRaw`SELECT 1 FROM "Plan" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const before = await tx.plan.findUnique({ where: { id } });
      if (!before) throw notFound('plan.notFound');
      const termsChanged =
        (input.monthlyPrice !== undefined && !new Prisma.Decimal(input.monthlyPrice).equals(before.monthlyPrice)) ||
        (input.maxActiveWorkers !== undefined && input.maxActiveWorkers !== before.maxActiveWorkers) ||
        (input.timesheetModule !== undefined && input.timesheetModule !== before.timesheetModule);
      if (termsChanged && (await tx.companyPlan.count({ where: { planId: id } })) > 0) throw conflict('plan.inUse');
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
