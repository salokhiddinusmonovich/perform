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
  /** null for a company from before plans */
  plan: { id: string; name: string; maxActiveWorkers: number; timesheetModule: boolean } | null;
  subscription: SubscriptionState;
  /** Workers with a placement this month (what the plan's limit counts) */
  activeWorkers: number;
}

export interface PaymentView {
  id: string;
  /** Decimal string, soʻm */
  amount: string;
  paidOn: string;
  paidUntil: string;
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
        plan: true,
        _count: { select: { memberships: { where: { isActive: true, acceptedAt: { not: null } } } } },
        memberships: { where: { role: 'OWNER', isActive: true, acceptedAt: { not: null } }, include: { user: true } },
      },
    });
    return Promise.all(
      companies.map(async (c) => {
        const today = todayIn(c.timezone);
        const { year, month } = monthOfDay(today);
        return {
          id: c.id,
          name: c.name,
          currency: c.currency,
          timezone: c.timezone,
          isActive: c.isActive,
          createdAt: c.createdAt,
          memberCount: c._count.memberships,
          owners: c.memberships.map((m) => ({ fullName: m.user.fullName, email: m.user.email, phone: m.user.phone })),
          plan: c.plan && {
            id: c.plan.id,
            name: c.plan.name,
            maxActiveWorkers: c.plan.maxActiveWorkers,
            timesheetModule: c.plan.timesheetModule,
          },
          subscription: subscriptionState(c, today),
          activeWorkers: await countActiveWorkers(this.prisma, c.id, year, month),
        };
      }),
    );
  }

  /** Creates a company on a plan and makes the given person its owner (new account if needed). */
  async create(auth: AuthContext, input: CreateCompany) {
    return this.prisma.$transaction(async (tx) => {
      const plan = await offeredPlan(tx, input.planId);
      const company = await tx.company.create({
        data: {
          name: input.name,
          currency: input.currency,
          timezone: input.timezone,
          slug: await uniqueSlug(tx, input.name),
          planId: plan.id,
          paidUntil: dayToDate(input.paidUntil),
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
            paidUntil: input.paidUntil,
          },
        },
        tx,
      );
      return { companyId: company.id, ownerUserId: user.id, temporaryPassword: temporaryPassword ?? null };
    });
  }

  /** Changes a company's settings, its plan, or whether it is active. */
  async update(auth: AuthContext, companyId: string, changes: UpdatePlatformCompany) {
    await this.prisma.$transaction(async (tx) => {
      const company = await findCompany(tx, companyId);
      const { isActive, planId, ...settings } = changes;
      const planChanged = planId !== undefined && planId !== company.planId;
      // A company may keep a plan that was archived, but isn't moved onto one.
      if (planChanged) await offeredPlan(tx, planId);
      await tx.company.update({ where: { id: companyId }, data: changes });

      const record = (action: string, data?: Prisma.InputJsonObject) =>
        this.audit.record({ action, companyId, auth, entityType: 'Company', entityId: companyId, data }, tx);
      const settingsChanged = diff({ name: company.name, currency: company.currency, timezone: company.timezone }, settings);
      if (Object.keys(settingsChanged).length > 0) await record('company.update', settingsChanged);
      if (isActive !== undefined && isActive !== company.isActive) {
        await record(isActive ? 'company.activate' : 'company.deactivate');
      }
      if (planChanged) await record('company.planChange', { from: company.planId, to: planId });
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
      paidUntil: isoDay(p.paidUntil),
      note: p.note,
      recordedBy: p.recordedBy.fullName,
      createdAt: p.createdAt,
    }));
  }

  /** Records a payment made outside the app; it sets the company's paid-until date. */
  async recordPayment(auth: AuthContext, companyId: string, input: SubscriptionPayment): Promise<{ id: string }> {
    return this.prisma.$transaction(async (tx) => {
      const company = await findCompany(tx, companyId);
      const payment = await tx.subscriptionPayment.create({
        data: {
          companyId,
          amount: input.amount,
          paidOn: dayToDate(input.paidOn),
          paidUntil: dayToDate(input.paidUntil),
          note: input.note,
          recordedById: auth.user.id,
        },
      });
      await tx.company.update({ where: { id: companyId }, data: { paidUntil: dayToDate(input.paidUntil) } });
      await this.audit.record(
        {
          action: 'company.payment',
          companyId,
          auth,
          entityType: 'SubscriptionPayment',
          entityId: payment.id,
          data: { ...input, previousPaidUntil: company.paidUntil ? isoDay(company.paidUntil) : null },
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
