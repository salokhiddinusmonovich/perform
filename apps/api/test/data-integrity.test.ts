import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCompany, createUser, resetDb, startApp, type TestContext } from './helpers';

/** Prisma error codes: a row other rows still point to; a duplicate of a unique value. */
const STILL_REFERENCED = { code: 'P2003' };
const UNIQUE_VIOLATION = { code: 'P2002' };

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

/** A company with one worker who has one timesheet day and one adjustment. */
async function workerWithHistory() {
  const { prisma } = ctx;
  const company = await createCompany(prisma);
  const site = await prisma.site.create({ data: { companyId: company.id, name: 'Site A' } });
  const team = await prisma.team.create({ data: { companyId: company.id, siteId: site.id, name: 'Team A' } });
  const worker = await prisma.worker.create({ data: { companyId: company.id, lastName: 'Testov', firstName: 'Test' } });
  const assignment = await prisma.assignment.create({
    data: {
      workerId: worker.id,
      siteId: site.id,
      teamId: team.id,
      hiredOn: new Date('2026-09-01'),
      monthlySalary: '5000000',
    },
  });
  const period = await prisma.payrollPeriod.create({ data: { companyId: company.id, year: 2026, month: 9 } });
  await prisma.timesheetEntry.create({
    data: { periodId: period.id, assignmentId: assignment.id, date: new Date('2026-09-01'), status: 'WORKED', hours: 9 },
  });
  await prisma.adjustment.create({
    data: { periodId: period.id, assignmentId: assignment.id, type: 'BONUS', amount: '100000' },
  });
  return { company, site, team, worker, assignment, period };
}

describe('history is never deleted by accident', () => {
  it('refuses to delete anything that timesheets or payroll depend on', async () => {
    const { prisma } = ctx;
    const { company, site, team, worker, assignment, period } = await workerWithHistory();

    await expect(prisma.worker.delete({ where: { id: worker.id } })).rejects.toMatchObject(STILL_REFERENCED);
    await expect(prisma.assignment.delete({ where: { id: assignment.id } })).rejects.toMatchObject(STILL_REFERENCED);
    await expect(prisma.payrollPeriod.delete({ where: { id: period.id } })).rejects.toMatchObject(STILL_REFERENCED);
    await expect(prisma.team.delete({ where: { id: team.id } })).rejects.toMatchObject(STILL_REFERENCED);
    await expect(prisma.site.delete({ where: { id: site.id } })).rejects.toMatchObject(STILL_REFERENCED);
    await expect(prisma.company.delete({ where: { id: company.id } })).rejects.toMatchObject(STILL_REFERENCED);

    expect(await prisma.timesheetEntry.count()).toBe(1);
    expect(await prisma.adjustment.count()).toBe(1);
  });

  it("refuses to delete a site that limits a member's access, instead of widening it to all sites", async () => {
    const { prisma } = ctx;
    const company = await createCompany(prisma);
    const site = await prisma.site.create({ data: { companyId: company.id, name: 'Site A' } });
    const user = await createUser(prisma);
    await prisma.membership.create({ data: { userId: user.id, companyId: company.id, role: 'FOREMAN', siteId: site.id } });

    await expect(prisma.site.delete({ where: { id: site.id } })).rejects.toMatchObject(STILL_REFERENCED);
    const membership = await prisma.membership.findFirstOrThrow({ where: { userId: user.id } });
    expect(membership.siteId).toBe(site.id);
  });

  it('keeps audit records when someone tries to delete the user or company they mention', async () => {
    const { prisma } = ctx;
    const company = await createCompany(prisma);
    const user = await createUser(prisma);
    await prisma.auditLog.create({ data: { action: 'test.action', companyId: company.id, actorUserId: user.id } });

    await expect(prisma.user.delete({ where: { id: user.id } })).rejects.toMatchObject(STILL_REFERENCED);
    await expect(prisma.company.delete({ where: { id: company.id } })).rejects.toMatchObject(STILL_REFERENCED);
    const log = await prisma.auditLog.findFirstOrThrow();
    expect(log).toMatchObject({ companyId: company.id, actorUserId: user.id });
  });

  it('lets workers and teams be deactivated instead', async () => {
    const { prisma } = ctx;
    const { worker, team } = await workerWithHistory();
    expect(worker.isActive).toBe(true);
    expect(team.isActive).toBe(true);
    await prisma.worker.update({ where: { id: worker.id }, data: { isActive: false } });
    await prisma.team.update({ where: { id: team.id }, data: { isActive: false } });
    expect(await prisma.timesheetEntry.count()).toBe(1);
  });
});

describe('payroll rule sets', () => {
  it('allows one company default and one rule set per site', async () => {
    const { prisma } = ctx;
    const company = await createCompany(prisma);
    const other = await createCompany(prisma);
    const siteA = await prisma.site.create({ data: { companyId: company.id, name: 'Site A' } });
    const siteB = await prisma.site.create({ data: { companyId: company.id, name: 'Site B' } });

    await prisma.payrollRuleSet.create({ data: { companyId: company.id, name: 'Default' } });
    await expect(prisma.payrollRuleSet.create({ data: { companyId: company.id, name: 'Second default' } })).rejects.toMatchObject(UNIQUE_VIOLATION);

    await prisma.payrollRuleSet.create({ data: { companyId: company.id, siteId: siteA.id, name: 'Site A' } });
    await prisma.payrollRuleSet.create({ data: { companyId: company.id, siteId: siteB.id, name: 'Site B' } });
    await expect(
      prisma.payrollRuleSet.create({ data: { companyId: company.id, siteId: siteA.id, name: 'Site A again' } }),
    ).rejects.toMatchObject(UNIQUE_VIOLATION);

    // Another company has its own default.
    await prisma.payrollRuleSet.create({ data: { companyId: other.id, name: 'Default' } });
  });
});
