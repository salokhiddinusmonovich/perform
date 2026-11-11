import type { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Role } from '@prisma/client';
import request from 'supertest';
import TestAgent from 'supertest/lib/agent';
import { inject } from 'vitest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { hashPassword } from '../src/auth/passwords';
import { PrismaService } from '../src/prisma/prisma.service';

export const PASSWORD = 'correct-horse-battery';

export interface TestContext {
  app: INestApplication;
  prisma: PrismaService;
}

/** Starts the real app; `controllers` adds test-only routes (e.g. to probe a guard). */
export async function startApp(controllers: Type[] = []): Promise<TestContext> {
  process.env.DATABASE_URL = inject('databaseUrl');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule], controllers }).compile();
  const app = configureApp(moduleRef.createNestApplication());
  await app.init();
  return { app, prisma: app.get(PrismaService) };
}

/** Empties every table except the migration history. */
export async function resetDb(prisma: PrismaService) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AuditLog", "Session", "SubscriptionPayment", "CompanyPlan", "MemberSite", "MemberTeam", "Membership", "PayrollSnapshotWorker", "PayrollSnapshot", "Salary", "MonthlyHours", "TimesheetEntry", "TimesheetSettings", "AdjustmentCancel", "Adjustment", "TravelAmount", "PayrollPeriod", "WorkingDaysOverride", "PayrollRules", "PayrollRuleSet", "Holiday", "TimesheetCode", "Assignment", "TravelRoute", "Worker", "Team", "Site", "User", "Company", "Plan" CASCADE',
  );
}

let counter = 0;

export async function createUser(
  prisma: PrismaService,
  data: { email?: string; phone?: string; mustChangePassword?: boolean; isPlatformAdmin?: boolean; isActive?: boolean } = {},
) {
  counter++;
  return prisma.user.create({
    data: {
      fullName: `Test User ${counter}`,
      email: data.email ?? (data.phone ? null : `user${counter}@test.local`),
      phone: data.phone ?? null,
      passwordHash: await hashPassword(PASSWORD),
      mustChangePassword: data.mustChangePassword ?? false,
      isPlatformAdmin: data.isPlatformAdmin ?? false,
      isActive: data.isActive ?? true,
    },
  });
}

export async function createCompany(prisma: PrismaService, name = `Company ${++counter}`) {
  return prisma.company.create({ data: { name, slug: `c-${counter}-${Date.now()}` } });
}

export async function createPlan(
  prisma: PrismaService,
  data: { maxActiveWorkers?: number; timesheetModule?: boolean; isActive?: boolean } = {},
) {
  return prisma.plan.create({
    data: {
      name: `Plan ${++counter}`,
      monthlyPrice: '1000000',
      maxActiveWorkers: data.maxActiveWorkers ?? 100,
      timesheetModule: data.timesheetModule ?? false,
      isActive: data.isActive ?? true,
    },
  });
}

/** Puts a company on a plan from a month ("YYYY-MM-01"; by default long before any test data). */
export async function givePlan(prisma: PrismaService, companyId: string, planId: string, fromMonth = '2000-01-01') {
  return prisma.companyPlan.create({ data: { companyId, planId, fromMonth: new Date(fromMonth) } });
}

export async function addMember(prisma: PrismaService, userId: string, companyId: string, role: Role) {
  return prisma.membership.create({ data: { userId, companyId, role, acceptedAt: new Date() } });
}

/** A cookie-keeping client, logged in as the given login. */
export async function loginAs(app: INestApplication, identifier: string, password = PASSWORD): Promise<TestAgent> {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/api/auth/login').send({ identifier, password }).expect(204);
  return agent;
}

export interface PaySetup {
  categoryId: string;
  /** The first paid option's id */
  optionId: string;
  /** Each option's id by name */
  options: Record<string, string>;
  /** The worker categories to hire workers with, so these rules pay them (the first paid option) */
  categories: Record<string, string>;
  ruleSetId: string;
  /** The first paid option's combination: `/api/rule-sets/${combinationId}/pay-rules/…` changes its rules */
  combinationId: string;
}

/**
 * Pay rules the way an owner sets them up (AGENTS.md: Pay rule sets), for tests about something
 * else: a pay category ("Pay group" with options A and B unless given), a rule set "Main" that the
 * company uses from the month with these rules for the paid options (A unless given), and the
 * rounding step. Only workers with a paid option are paid: hire them with `categories`.
 */
export async function setUpPay(
  agent: TestAgent,
  rules: object,
  {
    year = 2026,
    month = 9,
    step = '1000',
    category = 'Pay group',
    options = ['A', 'B'],
    paid = [options[0]],
  }: { year?: number; month?: number; step?: string; category?: string; options?: string[]; paid?: string[] } = {},
): Promise<PaySetup> {
  const categoryId = (await agent.post('/api/worker-categories').send({ name: category, options }).expect(201)).body.id as string;
  const all = (await agent.get('/api/worker-categories').expect(200)).body as { id: string; options: { id: string; name: string }[] }[];
  const optionIds = Object.fromEntries(all.find((c) => c.id === categoryId)!.options.map((o) => [o.name, o.id]));
  await agent.put(`/api/pay-categories/${year}/${month}`).send({ categoryIds: [categoryId] }).expect(204);
  await agent.put(`/api/pay-rounding/${year}/${month}`).send({ step }).expect(204);
  const ruleSetId = (await agent.post('/api/rule-sets').send({ name: 'Main' }).expect(201)).body.id as string;
  const combinations: string[] = [];
  for (const option of paid) {
    const id = (await agent.post(`/api/rule-sets/${ruleSetId}/variants`).send({ optionIds: [optionIds[option]] }).expect(201)).body.id as string;
    await agent.put(`/api/rule-sets/${id}/pay-rules/${year}/${month}`).send(rules).expect(204);
    combinations.push(id);
  }
  await agent.put(`/api/company/rule-set/${year}/${month}`).send({ ruleSetId }).expect(204);
  const optionId = optionIds[paid[0]];
  return { categoryId, optionId, options: optionIds, categories: { [categoryId]: optionId }, ruleSetId, combinationId: combinations[0] };
}

/** setUpPay's `categories` for a company, to hire workers its rules pay; empty before setUpPay. */
export async function paidCategories(agent: TestAgent): Promise<Record<string, string>> {
  const all = (await agent.get('/api/worker-categories').expect(200)).body as { id: string; name: string; options: { id: string; name: string }[] }[];
  const group = all.find((c) => c.name === 'Pay group');
  return group ? { [group.id]: group.options.find((o) => o.name === 'A')!.id } : {};
}

/** One user who is the given role in a fresh company, logged in. */
export async function memberOfNewCompany(ctx: TestContext, role: Role) {
  const company = await createCompany(ctx.prisma);
  const user = await createUser(ctx.prisma);
  await addMember(ctx.prisma, user.id, company.id, role);
  const agent = await loginAs(ctx.app, user.email!);
  return { company, user, agent };
}
