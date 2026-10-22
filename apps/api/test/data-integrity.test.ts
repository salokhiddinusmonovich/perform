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
      companyId: company.id,
      workerId: worker.id,
      siteId: site.id,
      teamId: team.id,
      hiredOn: new Date('2026-09-01'),
    },
  });
  const user = await createUser(prisma);
  await prisma.salary.create({
    data: { companyId: company.id, assignmentId: assignment.id, fromDate: new Date('2026-09-01'), monthlySalary: '5000000', setById: user.id },
  });
  const period = await prisma.payrollPeriod.create({ data: { companyId: company.id, year: 2026, month: 9 } });
  await prisma.timesheetEntry.create({
    data: {
      companyId: company.id,
      periodId: period.id,
      assignmentId: assignment.id,
      siteId: site.id,
      teamId: team.id,
      date: new Date('2026-09-01'),
      status: 'WORKED',
      hours: 9,
    },
  });
  await prisma.adjustment.create({
    data: { companyId: company.id, periodId: period.id, assignmentId: assignment.id, type: 'BONUS', amount: '100000' },
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

    expect(await prisma.salary.count()).toBe(1);

    await prisma.timesheetEntry.deleteMany();
    await prisma.adjustment.deleteMany();
    // The salary history alone keeps the placement too.
    await expect(prisma.assignment.delete({ where: { id: assignment.id } })).rejects.toMatchObject(STILL_REFERENCED);
  });

  it("refuses to delete a site or team a member is assigned to, instead of silently dropping the assignment", async () => {
    const { prisma } = ctx;
    const company = await createCompany(prisma);
    const site = await prisma.site.create({ data: { companyId: company.id, name: 'Site A' } });
    const team = await prisma.team.create({ data: { companyId: company.id, siteId: site.id, name: 'Team A' } });
    const timekeeper = await createUser(prisma);
    const foreman = await createUser(prisma);
    await prisma.membership.create({ data: { userId: timekeeper.id, companyId: company.id, role: 'TIMEKEEPER' } });
    await prisma.membership.create({ data: { userId: foreman.id, companyId: company.id, role: 'FOREMAN' } });
    await prisma.memberSite.create({ data: { userId: timekeeper.id, companyId: company.id, siteId: site.id } });
    await prisma.memberTeam.create({ data: { userId: foreman.id, companyId: company.id, teamId: team.id } });

    await expect(prisma.team.delete({ where: { id: team.id } })).rejects.toMatchObject(STILL_REFERENCED);
    await prisma.memberTeam.deleteMany();
    await prisma.team.delete({ where: { id: team.id } });
    await expect(prisma.site.delete({ where: { id: site.id } })).rejects.toMatchObject(STILL_REFERENCED);
    expect(await prisma.memberSite.count()).toBe(1);
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

/** Made-up pay rules from a month; the values only need to be valid. */
function rules(companyId: string, ruleSetId: string, setById: string, fromMonth = 9) {
  return {
    companyId,
    ruleSetId,
    setById,
    fromYear: 2026,
    fromMonth,
    restWeekdays: [7],
    normalHoursPerDay: '9',
    overtimeMultiplier: '1.5',
    restDayMultiplier: '2',
    holidayMultiplier: '2',
    leavePaid: true,
    sickPaid: true,
    sickHoursPerDay: '8',
    travelDayPaid: false,
    travelPayMode: 'NONE' as const,
    payRoundingStep: '1000',
  };
}

describe('payroll rule sets', () => {
  it('allows one company default and one rule set per site', async () => {
    const { prisma } = ctx;
    const company = await createCompany(prisma);
    const other = await createCompany(prisma);
    const siteA = await prisma.site.create({ data: { companyId: company.id, name: 'Site A' } });
    const siteB = await prisma.site.create({ data: { companyId: company.id, name: 'Site B' } });

    await prisma.payrollRuleSet.create({ data: { companyId: company.id } });
    await expect(prisma.payrollRuleSet.create({ data: { companyId: company.id } })).rejects.toMatchObject(UNIQUE_VIOLATION);

    await prisma.payrollRuleSet.create({ data: { companyId: company.id, siteId: siteA.id } });
    await prisma.payrollRuleSet.create({ data: { companyId: company.id, siteId: siteB.id } });
    await expect(
      prisma.payrollRuleSet.create({ data: { companyId: company.id, siteId: siteA.id } }),
    ).rejects.toMatchObject(UNIQUE_VIOLATION);

    // Another company has its own default.
    await prisma.payrollRuleSet.create({ data: { companyId: other.id } });
  });

  it('keeps one version of the rules per rule set and month', async () => {
    const { prisma } = ctx;
    const company = await createCompany(prisma);
    const user = await createUser(prisma);
    const set = await prisma.payrollRuleSet.create({ data: { companyId: company.id } });

    await prisma.payrollRules.create({ data: rules(company.id, set.id, user.id, 9) });
    await prisma.payrollRules.create({ data: rules(company.id, set.id, user.id, 11) });
    await expect(prisma.payrollRules.create({ data: rules(company.id, set.id, user.id, 9) })).rejects.toMatchObject(
      UNIQUE_VIOLATION,
    );
  });

  it('refuses settings out of range', async () => {
    const { prisma } = ctx;
    const company = await createCompany(prisma);
    const user = await createUser(prisma);
    const set = await prisma.payrollRuleSet.create({ data: { companyId: company.id } });
    const bad = [
      { fromMonth: 13 },
      { normalHoursPerDay: '0' },
      { normalHoursPerDay: '25' },
      { overtimeMultiplier: '-1' },
      { sickHoursPerDay: '24.5' },
      { restWeekdays: [8] },
      { restWeekdays: [1, 2, 3, 4, 5, 6, 7] },
      { payRoundingStep: '0' },
    ];
    for (const override of bad) {
      await expect(
        prisma.payrollRules.create({ data: { ...rules(company.id, set.id, user.id), ...override } }),
      ).rejects.toThrow(/PayrollRules_settings_check/);
    }
    const created = await prisma.payrollRules.create({ data: rules(company.id, set.id, user.id) });
    expect(created.leaveHoursPerDay).toBeNull();
    expect(created.payRoundingStep.toString()).toBe('1000');
  });
});

describe('timesheet codes', () => {
  it('refuses a blank code', async () => {
    const { prisma } = ctx;
    const company = await createCompany(prisma);
    for (const code of ['', ' T']) {
      await expect(prisma.timesheetCode.create({ data: { companyId: company.id, code, status: 'OFF' } })).rejects.toThrow(
        /TimesheetCode_code_check/,
      );
    }
    await prisma.timesheetCode.create({ data: { companyId: company.id, code: 'T', status: 'OFF' } });
  });
});

describe('rows never mix two companies', () => {
  it('refuses a worker, site, team or travel route from another company', async () => {
    const { prisma } = ctx;
    const a = await workerWithHistory();
    const other = await createCompany(prisma);
    const otherSite = await prisma.site.create({ data: { companyId: other.id, name: 'Site B' } });
    const otherTeam = await prisma.team.create({ data: { companyId: other.id, siteId: otherSite.id, name: 'Team B' } });
    const otherRoute = await prisma.travelRoute.create({
      data: { companyId: other.id, name: 'Route B', amountPerDay: '20000' },
    });
    const assignment = {
      companyId: a.company.id,
      workerId: a.worker.id,
      siteId: a.site.id,
      hiredOn: new Date('2026-09-01'),
    };

    for (const data of [
      { ...assignment, siteId: otherSite.id },
      { ...assignment, teamId: otherTeam.id },
      { ...assignment, travelRouteId: otherRoute.id },
      // Claiming the other company doesn't help: the worker isn't theirs.
      { ...assignment, companyId: other.id, siteId: otherSite.id },
    ]) {
      await expect(prisma.assignment.create({ data })).rejects.toMatchObject(STILL_REFERENCED);
    }
    await expect(
      prisma.team.create({ data: { companyId: a.company.id, siteId: otherSite.id, name: 'Team X' } }),
    ).rejects.toMatchObject(STILL_REFERENCED);
    await expect(
      prisma.payrollRuleSet.create({ data: { companyId: a.company.id, siteId: otherSite.id } }),
    ).rejects.toMatchObject(STILL_REFERENCED);

    const user = await createUser(prisma);
    await prisma.membership.create({ data: { userId: user.id, companyId: a.company.id, role: 'TIMEKEEPER' } });
    await expect(
      prisma.memberSite.create({ data: { userId: user.id, companyId: a.company.id, siteId: otherSite.id } }),
    ).rejects.toMatchObject(STILL_REFERENCED);
    await expect(
      prisma.memberTeam.create({ data: { userId: user.id, companyId: a.company.id, teamId: otherTeam.id } }),
    ).rejects.toMatchObject(STILL_REFERENCED);
    // Not a member of the other company at all.
    await expect(
      prisma.memberSite.create({ data: { userId: user.id, companyId: other.id, siteId: otherSite.id } }),
    ).rejects.toMatchObject(STILL_REFERENCED);
  });

  it("refuses timesheet days and adjustments in another company's period", async () => {
    const { prisma } = ctx;
    const a = await workerWithHistory();
    const other = await createCompany(prisma);
    const otherPeriod = await prisma.payrollPeriod.create({ data: { companyId: other.id, year: 2026, month: 9 } });
    const day = {
      assignmentId: a.assignment.id,
      siteId: a.site.id,
      date: new Date('2026-09-02'),
      status: 'WORKED' as const,
      hours: 9,
    };

    for (const companyId of [a.company.id, other.id]) {
      await expect(
        prisma.timesheetEntry.create({ data: { ...day, companyId, periodId: otherPeriod.id } }),
      ).rejects.toMatchObject(STILL_REFERENCED);
      await expect(
        prisma.adjustment.create({
          data: { companyId, periodId: otherPeriod.id, assignmentId: a.assignment.id, type: 'BONUS', amount: '1' },
        }),
      ).rejects.toMatchObject(STILL_REFERENCED);
    }
    await prisma.timesheetEntry.create({ data: { ...day, companyId: a.company.id, periodId: a.period.id } });
  });

  it("refuses pay rules on another company's rule set", async () => {
    const { prisma } = ctx;
    const company = await createCompany(prisma);
    const other = await createCompany(prisma);
    const user = await createUser(prisma);
    const otherSet = await prisma.payrollRuleSet.create({ data: { companyId: other.id } });

    await expect(
      prisma.payrollRules.create({ data: rules(company.id, otherSet.id, user.id) }),
    ).rejects.toMatchObject(STILL_REFERENCED);
    await prisma.payrollRules.create({ data: rules(other.id, otherSet.id, user.id) });
  });

  it("refuses a working-days override on another company's rule set", async () => {
    const { prisma } = ctx;
    const company = await createCompany(prisma);
    const other = await createCompany(prisma);
    const user = await createUser(prisma);
    const otherRules = await prisma.payrollRuleSet.create({ data: { companyId: other.id } });
    const override = { ruleSetId: otherRules.id, year: 2026, month: 9, workingDays: 24, setById: user.id };

    await expect(
      prisma.workingDaysOverride.create({ data: { ...override, companyId: company.id } }),
    ).rejects.toMatchObject(STILL_REFERENCED);
    await prisma.workingDaysOverride.create({ data: { ...override, companyId: other.id } });
    // Corrections are newer rows, including "back to the calculated value" (null).
    await prisma.workingDaysOverride.create({ data: { ...override, companyId: other.id, workingDays: null } });
    await expect(
      prisma.workingDaysOverride.create({ data: { ...override, companyId: other.id, month: 13 } }),
    ).rejects.toThrow(/WorkingDaysOverride_range_check/);
  });
});

describe('payroll periods and timesheet days', () => {
  it('records who locked a period, and only for locked periods', async () => {
    const { prisma } = ctx;
    const company = await createCompany(prisma);
    const user = await createUser(prisma);
    const period = await prisma.payrollPeriod.create({ data: { companyId: company.id, year: 2026, month: 9 } });

    await expect(
      prisma.payrollPeriod.update({ where: { id: period.id }, data: { status: 'LOCKED' } }),
    ).rejects.toThrow(/PayrollPeriod_lock_check/);
    await expect(
      prisma.payrollPeriod.update({ where: { id: period.id }, data: { lockedAt: new Date(), lockedById: user.id } }),
    ).rejects.toThrow(/PayrollPeriod_lock_check/);
    const locked = await prisma.payrollPeriod.update({
      where: { id: period.id },
      data: { status: 'LOCKED', lockedAt: new Date(), lockedById: user.id },
    });
    expect(locked.lockedById).toBe(user.id);
  });

  it('allows hours only on worked days, up to 24', async () => {
    const { prisma } = ctx;
    const { company, site, period, assignment } = await workerWithHistory();
    const day = { companyId: company.id, periodId: period.id, assignmentId: assignment.id, siteId: site.id };
    const bad = [
      { date: new Date('2026-09-02'), status: 'WORKED' as const, hours: 0 },
      { date: new Date('2026-09-03'), status: 'WORKED' as const, hours: 24.5 },
      { date: new Date('2026-09-04'), status: 'SICK' as const, hours: 8 },
    ];
    for (const entry of bad) {
      await expect(prisma.timesheetEntry.create({ data: { ...day, ...entry } })).rejects.toThrow(
        /TimesheetEntry_hours_check/,
      );
    }
    await prisma.timesheetEntry.create({ data: { ...day, date: new Date('2026-09-05'), status: 'SICK' } });
  });
});

describe('a day worked at several sites or teams', () => {
  it('stores one entry per worker, day, site and team', async () => {
    const { prisma } = ctx;
    const { company, site, team, period, assignment } = await workerWithHistory();
    const siteB = await prisma.site.create({ data: { companyId: company.id, name: 'Site B' } });
    const teamA2 = await prisma.team.create({ data: { companyId: company.id, siteId: site.id, name: 'Team A2' } });
    // workerWithHistory has 9 h at Site A / Team A on 2026-09-01.
    const day = {
      companyId: company.id,
      periodId: period.id,
      assignmentId: assignment.id,
      date: new Date('2026-09-01'),
      status: 'WORKED' as const,
      hours: 2,
    };

    await prisma.timesheetEntry.create({ data: { ...day, siteId: site.id, teamId: teamA2.id } });
    await prisma.timesheetEntry.create({ data: { ...day, siteId: siteB.id } });
    await expect(
      prisma.timesheetEntry.create({ data: { ...day, siteId: site.id, teamId: team.id } }),
    ).rejects.toMatchObject(UNIQUE_VIOLATION);
    // Without a team, a second entry for the same site still collides.
    await expect(prisma.timesheetEntry.create({ data: { ...day, siteId: siteB.id } })).rejects.toMatchObject(
      UNIQUE_VIOLATION,
    );
    expect(await prisma.timesheetEntry.count({ where: { assignmentId: assignment.id } })).toBe(3);

    // A site or team with timesheet history can't be deleted, even with no assignment on it.
    await expect(prisma.site.delete({ where: { id: siteB.id } })).rejects.toMatchObject(STILL_REFERENCED);
    await expect(prisma.team.delete({ where: { id: teamA2.id } })).rejects.toMatchObject(STILL_REFERENCED);
  });

  it('records the order entries were created in, which edits do not change', async () => {
    const { prisma } = ctx;
    const { company, site, period, assignment } = await workerWithHistory();
    const siteB = await prisma.site.create({ data: { companyId: company.id, name: 'Site B' } });
    const day = {
      companyId: company.id,
      periodId: period.id,
      assignmentId: assignment.id,
      date: new Date('2026-09-02'),
      status: 'WORKED' as const,
    };
    const first = await prisma.timesheetEntry.create({ data: { ...day, siteId: site.id, hours: 6 } });
    const later = await prisma.timesheetEntry.create({ data: { ...day, siteId: siteB.id, hours: 5 } });
    expect(later.seq).toBeGreaterThan(first.seq);

    const edited = await prisma.timesheetEntry.update({ where: { id: first.id }, data: { hours: 7 } });
    expect(edited.seq).toBe(first.seq);
    expect(edited.createdAt).toEqual(first.createdAt);
  });

  it("refuses a team that is not on the entry's site, and a site or team from another company", async () => {
    const { prisma } = ctx;
    const a = await workerWithHistory();
    const siteB = await prisma.site.create({ data: { companyId: a.company.id, name: 'Site B' } });
    const other = await createCompany(prisma);
    const otherSite = await prisma.site.create({ data: { companyId: other.id, name: 'Site X' } });
    const otherTeam = await prisma.team.create({ data: { companyId: other.id, siteId: otherSite.id, name: 'Team X' } });
    const day = {
      companyId: a.company.id,
      periodId: a.period.id,
      assignmentId: a.assignment.id,
      date: new Date('2026-09-03'),
      status: 'WORKED' as const,
      hours: 4,
    };

    for (const place of [
      { siteId: siteB.id, teamId: a.team.id }, // Team A is on Site A
      { siteId: otherSite.id },
      { siteId: otherSite.id, teamId: otherTeam.id },
      { siteId: a.site.id, teamId: otherTeam.id },
    ]) {
      await expect(prisma.timesheetEntry.create({ data: { ...day, ...place } })).rejects.toMatchObject(
        STILL_REFERENCED,
      );
    }
    await prisma.timesheetEntry.create({ data: { ...day, siteId: siteB.id } });
  });
});
