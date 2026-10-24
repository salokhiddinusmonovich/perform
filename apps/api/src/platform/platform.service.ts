import { Injectable } from '@nestjs/common';
import type { Plan, Prisma } from '@prisma/client';
import type { CreateCompany, SubscriptionPayment, UpdatePlatformCompany } from '@puantaj/schemas';
import { randomBytes } from 'node:crypto';
import { AuditService, diff } from '../audit/audit.service';
import type { AuthContext } from '../auth/auth.context';
import { conflict, notFound } from '../common/api-error';
import { dayToDate, isoDay, monthOfDay, todayIn } from '../common/dates';
import { countActiveWorkers } from '../organisation/worker-limit';
import { PrismaService } from '../prisma/prisma.service';
import { UserAccountsService } from '../users/user-accounts.service';
import { firstOfMonth, nextMonth, pendingPlan, planHistory, planOfMonth, PLAN_HISTORY } from './company-plan';
import { subscriptionState, type SubscriptionState } from './subscription';

export interface CompanyListItem {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  isActive: boolean;
  createdAt: Date;
  memberCount: number;
  owners: { fullName: string; email: string | null; phone: string | null }[];
  /** This month's plan; null for a company from before plans */
  plan: PlanSummary | null;
  /** A change that starts on the 1st of next month, or null */
  nextPlan: (PlanSummary & { fromMonth: string }) | null;
  subscription: SubscriptionState;
  /** Workers with a placement this month (what the plan's limit counts) */
  activeWorkers: number;
}

type PlanSummary = { id: string; name: string; maxActiveWorkers: number; timesheetModule: boolean };

const planSummary = (p: Plan): PlanSummary => ({
  id: p.id,
  name: p.name,
  maxActiveWorkers: p.maxActiveWorkers,
  timesheetModule: p.timesheetModule,
});

export interface PaymentView {
  id: string;
  /** Decimal string, soʻm */
  amount: string;
  paidOn: string;
  /** "YYYY-MM-01" */
  paidThrough: string;
  note: string | null;
  recordedBy: string;
  createdAt: Date;
}

/** Customer companies and their subscriptions, managed by platform admins (the product operator). */
@Injectable()
export class PlatformService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: UserAccountsService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<CompanyListItem[]> {
    const companies = await this.prisma.company.findMany({
      orderBy: { name: 'asc' },
      include: {
        plans: PLAN_HISTORY,
        _count: { select: { memberships: { where: { isActive: true, acceptedAt: { not: null } } } } },
        memberships: { where: { role: 'OWNER', isActive: true, acceptedAt: { not: null } }, include: { user: true } },
      },
    });
    return Promise.all(
      companies.map(async (c) => {
        const today = todayIn(c.timezone);
        const { year, month } = monthOfDay(today);
        const plan = planOfMonth(c.plans, { year, month });
        const next = pendingPlan(c.plans, today);
        return {
          id: c.id,
          name: c.name,
          currency: c.currency,
          timezone: c.timezone,
          isActive: c.isActive,
          createdAt: c.createdAt,
          memberCount: c._count.memberships,
          owners: c.memberships.map((m) => ({ fullName: m.user.fullName, email: m.user.email, phone: m.user.phone })),
          plan: plan && planSummary(plan),
          nextPlan: next && { ...planSummary(next.plan), fromMonth: next.fromMonth },
          subscription: subscriptionState({ paidThrough: c.paidThrough, plan }, today),
          activeWorkers: await countActiveWorkers(this.prisma, c.id, year, month),
        };
      }),
    );
  }

  /**
   * Creates a company on a plan and makes the given person its owner (new account if
   * needed). The plan starts on the 1st of this month: the company has no data yet, so the
   * month stays on one plan.
   */
  async create(auth: AuthContext, input: CreateCompany) {
    return this.prisma.$transaction(async (tx) => {
      const plan = await offeredPlan(tx, input.planId);
      const company = await tx.company.create({
        data: {
          name: input.name,
          currency: input.currency,
          timezone: input.timezone,
          slug: await uniqueSlug(tx, input.name),
          paidThrough: dayToDate(firstOfMonth(input.paidThrough)),
          plans: {
            create: {
              planId: plan.id,
              fromMonth: dayToDate(firstOfMonth(monthOfDay(todayIn(input.timezone)))),
              setById: auth.user.id,
            },
          },
        },
      });
      const { user, temporaryPassword } = await this.accounts.findOrCreate(tx, input.owner);
      // The platform operator sets up owners directly; there is nobody to invite them.
      await tx.membership.create({
        data: { userId: user.id, companyId: company.id, role: 'OWNER', acceptedAt: new Date() },
      });
      await this.audit.record(
        {
          action: 'company.create',
          companyId: company.id,
          auth,
          entityType: 'Company',
          entityId: company.id,
          data: {
            name: company.name,
            ownerUserId: user.id,
            newOwnerAccount: temporaryPassword !== undefined,
            planId: plan.id,
            paidThrough: firstOfMonth(input.paidThrough),
          },
        },
        tx,
      );
      return { companyId: company.id, ownerUserId: user.id, temporaryPassword: temporaryPassword ?? null };
    });
  }

  /**
   * Changes a company's settings, its plan, or whether it is active. A plan change starts
   * on the 1st of next month (AGENTS.md: Plans); choosing this month's plan again cancels
   * a pending change.
   */
  async update(auth: AuthContext, companyId: string, changes: UpdatePlatformCompany) {
    await this.prisma.$transaction(async (tx) => {
      const company = await findCompany(tx, companyId);
      const { isActive, planId, ...settings } = changes;
      const updated = await tx.company.update({ where: { id: companyId }, data: { isActive, ...settings } });

      const record = (action: string, data?: Prisma.InputJsonObject) =>
        this.audit.record({ action, companyId, auth, entityType: 'Company', entityId: companyId, data }, tx);
      const settingsChanged = diff({ name: company.name, currency: company.currency, timezone: company.timezone }, settings);
      if (Object.keys(settingsChanged).length > 0) await record('company.update', settingsChanged);
      if (isActive !== undefined && isActive !== company.isActive) {
        await record(isActive ? 'company.activate' : 'company.deactivate');
      }
      if (planId === undefined) return;

      const today = todayIn(updated.timezone);
      const history = await planHistory(tx, companyId);
      const current = planOfMonth(history, monthOfDay(today));
      const scheduled = pendingPlan(history, today)?.plan ?? current;
      if (planId === scheduled?.id) return;
      const fromMonth = firstOfMonth(nextMonth(today));
      const where = { companyId_fromMonth: { companyId, fromMonth: dayToDate(fromMonth) } };
      if (planId === current?.id) {
        await tx.companyPlan.delete({ where });
      } else {
        // A company may keep a plan that was archived, but isn't moved onto one.
        await offeredPlan(tx, planId);
        await tx.companyPlan.upsert({
          where,
          create: { companyId, planId, fromMonth: dayToDate(fromMonth), setById: auth.user.id },
          update: { planId, setById: auth.user.id, setAt: new Date() },
        });
      }
      await record('company.planChange', { from: scheduled?.id ?? null, to: planId, fromMonth });
    });
  }

  /** The company's recorded payments, newest first. */
  async payments(companyId: string): Promise<PaymentView[]> {
    await findCompany(this.prisma, companyId);
    const rows = await this.prisma.subscriptionPayment.findMany({
      where: { companyId },
      include: { recordedBy: { select: { fullName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((p) => ({
      id: p.id,
      amount: p.amount.toString(),
      paidOn: isoDay(p.paidOn),
      paidThrough: isoDay(p.paidThrough),
      note: p.note,
      recordedBy: p.recordedBy.fullName,
      createdAt: p.createdAt,
    }));
  }

  /** Records a payment made outside the app; it sets the month the company is paid through. */
  async recordPayment(auth: AuthContext, companyId: string, input: SubscriptionPayment): Promise<{ id: string }> {
    return this.prisma.$transaction(async (tx) => {
      const company = await findCompany(tx, companyId);
      const paidThrough = firstOfMonth(input.paidThrough);
      const payment = await tx.subscriptionPayment.create({
        data: {
          companyId,
          amount: input.amount,
          paidOn: dayToDate(input.paidOn),
          paidThrough: dayToDate(paidThrough),
          note: input.note,
          recordedById: auth.user.id,
        },
      });
      await tx.company.update({ where: { id: companyId }, data: { paidThrough: dayToDate(paidThrough) } });
      await this.audit.record(
        {
          action: 'company.payment',
          companyId,
          auth,
          entityType: 'SubscriptionPayment',
          entityId: payment.id,
          data: {
            ...input,
            paidThrough,
            previousPaidThrough: company.paidThrough ? isoDay(company.paidThrough) : null,
          },
        },
        tx,
      );
      return { id: payment.id };
    });
  }
}

async function findCompany(db: Prisma.TransactionClient, companyId: string) {
  const company = await db.company.findUnique({ where: { id: companyId } });
  if (!company) throw notFound('company.notFound');
  return company;
}

/** A plan that can be given to a company: it exists and isn't archived. */
async function offeredPlan(tx: Prisma.TransactionClient, planId: string): Promise<Plan> {
  // Its terms are fixed once a company has it (PlansService.update), so hold them while moving.
  await tx.$queryRaw`SELECT 1 FROM "Plan" WHERE "id" = ${planId}::uuid FOR SHARE`;
  const plan = await tx.plan.findUnique({ where: { id: planId } });
  if (!plan) throw notFound('plan.notFound');
  if (!plan.isActive) throw conflict('plan.archived');
  return plan;
}

/** URL-safe identifier from the name, e.g. "Perform MEP" → "perform-mep" (suffix if taken). */
async function uniqueSlug(tx: Prisma.TransactionClient, name: string) {
  const base =
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'company';
  let slug = base;
  while (await tx.company.findUnique({ where: { slug } })) {
    slug = `${base}-${randomBytes(2).toString('hex')}`;
  }
  return slug;
}
