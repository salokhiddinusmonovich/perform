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
    'TRUNCATE "AuditLog", "Session", "SubscriptionPayment", "MemberSite", "MemberTeam", "Membership", "Salary", "MonthlyHours", "TimesheetEntry", "Adjustment", "PayrollPeriod", "WorkingDaysOverride", "PayrollRules", "PayrollRuleSet", "Holiday", "TimesheetCode", "Assignment", "TravelRoute", "Worker", "Team", "Site", "User", "Company", "Plan" CASCADE',
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

export async function addMember(prisma: PrismaService, userId: string, companyId: string, role: Role) {
  return prisma.membership.create({ data: { userId, companyId, role, acceptedAt: new Date() } });
}

/** A cookie-keeping client, logged in as the given login. */
export async function loginAs(app: INestApplication, identifier: string, password = PASSWORD): Promise<TestAgent> {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/api/auth/login').send({ identifier, password }).expect(204);
  return agent;
}

/** One user who is the given role in a fresh company, logged in. */
export async function memberOfNewCompany(ctx: TestContext, role: Role) {
  const company = await createCompany(ctx.prisma);
  const user = await createUser(ctx.prisma);
  await addMember(ctx.prisma, user.id, company.id, role);
  const agent = await loginAs(ctx.app, user.email!);
  return { company, user, agent };
}
