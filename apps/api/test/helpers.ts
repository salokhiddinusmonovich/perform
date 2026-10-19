import type { INestApplication } from '@nestjs/common';
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

export async function startApp(): Promise<TestContext> {
  process.env.DATABASE_URL = inject('databaseUrl');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = configureApp(moduleRef.createNestApplication());
  await app.init();
  return { app, prisma: app.get(PrismaService) };
}

/** Empties every table except the migration history. */
export async function resetDb(prisma: PrismaService) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE "AuditLog", "Session", "Membership", "TimesheetEntry", "Adjustment", "PayrollPeriod", "PayrollRuleSet", "Holiday", "Assignment", "Worker", "Team", "Site", "User", "Company" CASCADE',
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

export async function addMember(prisma: PrismaService, userId: string, companyId: string, role: Role) {
  return prisma.membership.create({ data: { userId, companyId, role } });
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
