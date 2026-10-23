import type { Role } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, createUser, loginAs, memberOfNewCompany, resetDb, startApp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

// September 2026: Sept 1 is Independence Day and Sundays are rest days, so 25 working
// days; at 9 normal hours a salary of 7 500 000 makes an hourly rate of 33 333.33….
const RULES = {
  restWeekdays: [7],
  normalHoursPerDay: '9',
  overtimeMultiplier: '1.5',
  restDayMultiplier: '2',
  holidayMultiplier: '2',
  absence: {
    LEAVE: { paid: true, hoursPerDay: null },
    SICK: { paid: true, hoursPerDay: '8' },
    TRAVEL: { paid: false, hoursPerDay: null },
  },
  travelPayMode: 'NONE',
  payRoundingStep: '1000',
};

const FULL_MONTH = {
  normalHours: '225',
  overtimeHours: '0',
  restDayHours: '0',
  holidayHours: '0',
  workdaysWorked: 25,
  leaveDays: 0,
  sickDays: 0,
  travelDays: 0,
};

/** A company with pay rules from September 2026, two sites and one worker on site A with a salary. */
async function company(rules = RULES) {
  const owner = await memberOfNewCompany(ctx, 'OWNER');
  await owner.agent.put('/api/pay-rules/2026/9').send(rules).expect(204);
  const siteA = (await owner.agent.post('/api/sites').send({ name: 'Site A' }).expect(201)).body.id as string;
  const siteB = (await owner.agent.post('/api/sites').send({ name: 'Site B' }).expect(201)).body.id as string;
  const workerId = await hire(owner.agent, siteA, 'Testov');
  await owner.agent.post(`/api/workers/${workerId}/salaries`).send({ fromYear: 2026, fromMonth: 9, monthlySalary: '7500000' }).expect(201);
  const placementA = (await owner.agent.get(`/api/workers/${workerId}`).expect(200)).body.placement.id as string;
  return { ...owner, siteA, siteB, workerId, placementA };
}

async function hire(agent: Awaited<ReturnType<typeof memberOfNewCompany>>['agent'], siteId: string, lastName: string, from = '2026-09-01') {
  const res = await agent
    .post('/api/workers')
    .send({
      worker: { lastName, firstName: 'Test', employmentType: 'DIRECT' },
      placement: { siteId, from, shift: 'DAY' },
    })
    .expect(201);
  return res.body.id as string;
}

async function member(companyId: string, role: Role) {
  const user = await createUser(ctx.prisma);
  await addMember(ctx.prisma, user.id, companyId, role);
  return { user, agent: await loginAs(ctx.app, user.email!) };
}

/** A daily timesheet entry, written directly: there is no hour entry API yet. */
async function dailyEntry(companyId: string, assignmentId: string, siteId: string, date: string) {
  const period =
    (await ctx.prisma.payrollPeriod.findUnique({ where: { companyId_year_month: { companyId, year: 2026, month: 9 } } })) ??
    (await ctx.prisma.payrollPeriod.create({ data: { companyId, year: 2026, month: 9 } }));
  await ctx.prisma.timesheetEntry.create({
    data: { companyId, periodId: period.id, assignmentId, siteId, date: new Date(`${date}T00:00:00Z`), status: 'WORKED', hours: 9 },
  });
}

describe('monthly hours', () => {
  it('lets an accountant add totals per placement, newest first, with corrections and audit records', async () => {
    const { company: c, placementA } = await company();
    const accountant = await member(c.id, 'ACCOUNTANT');
    const url = `/api/monthly-hours/2026/9/${placementA}`;
    await accountant.agent.post(url).send({ ...FULL_MONTH, normalHours: '216', workdaysWorked: 24 }).expect(201);
    const same = await accountant.agent.post(url).send({ ...FULL_MONTH, normalHours: '216', workdaysWorked: 24, note: 'x' }).expect(409);
    expect(same.body.code).toBe('monthlyHours.unchanged');
    await accountant.agent.post(url).send({ ...FULL_MONTH, note: 'Missed a day' }).expect(201);

    const month = (await accountant.agent.get('/api/monthly-hours/2026/9').expect(200)).body;
    expect(month).toMatchObject({ year: 2026, month: 9, locked: false });
    expect(month.rows).toHaveLength(1);
    expect(month.rows[0]).toMatchObject({ assignmentId: placementA, siteName: 'Site A', from: '2026-09-01', hasDailyEntries: false });
    expect(month.rows[0].history.map((h: { normalHours: string; corrected: boolean }) => [h.normalHours, h.corrected])).toEqual([
      ['225', false],
      ['216', true],
    ]);
    const log = await ctx.prisma.auditLog.findMany({ where: { action: 'monthlyHours.add' }, orderBy: { createdAt: 'asc' } });
    expect(log.map((l) => l.data)).toEqual([
      expect.objectContaining({ from: null, to: expect.objectContaining({ normalHours: '216' }) }),
      expect.objectContaining({ from: expect.objectContaining({ normalHours: '216' }), to: expect.objectContaining({ normalHours: '225' }), note: 'Missed a day' }),
    ]);
  });

  it('refuses totals that cannot fit the month, outside the placement, in a locked month or without rules', async () => {
    const { company: c, agent, placementA, siteA } = await company();
    const url = `/api/monthly-hours/2026/9/${placementA}`;
    const tooMany = await agent.post(url).send({ ...FULL_MONTH, normalHours: '226', sickDays: 1 }).expect(400);
    expect(tooMany.body.issues).toEqual([
      { path: 'normalHours', message: 'validation.normalAboveDaysWorked' },
      { path: 'workdaysWorked', message: 'validation.daysAboveWorkingDays' },
    ]);
    const invalid = await agent.post(url).send({ ...FULL_MONTH, normalHours: '800', sickDays: 40 }).expect(400);
    expect(invalid.body.issues).toEqual([
      { path: 'normalHours', message: 'validation.monthHoursRange' },
      { path: 'sickDays', message: 'validation.daysRange' },
    ]);
    // A placement that starts in October has no September.
    const later = await hire(agent, siteA, 'Later', '2026-10-05');
    const laterPlacement = (await agent.get(`/api/workers/${later}`).expect(200)).body.placement.id;
    expect((await agent.post(`/api/monthly-hours/2026/9/${laterPlacement}`).send(FULL_MONTH).expect(409)).body.code).toBe(
      'monthlyHours.notInMonth',
    );
    // Without pay rules for the month, hours can't be checked.
    await agent.delete('/api/pay-rules/2026/9').expect(204);
    expect((await agent.post(url).send(FULL_MONTH).expect(409)).body.code).toBe('payRules.notSet');
    const user = await createUser(ctx.prisma);
    await ctx.prisma.payrollPeriod.create({ data: { companyId: c.id, year: 2026, month: 9, status: 'LOCKED', lockedAt: new Date(), lockedById: user.id } });
    expect((await agent.post(url).send(FULL_MONTH).expect(409)).body.code).toBe('period.locked');
    expect(await ctx.prisma.monthlyHours.count()).toBe(0);
  });

  it('keeps one source of hours per worker-month', async () => {
    const { company: c, agent, placementA, siteA } = await company();
    await dailyEntry(c.id, placementA, siteA, '2026-09-02');
    const res = await agent.post(`/api/monthly-hours/2026/9/${placementA}`).send(FULL_MONTH).expect(409);
    expect(res.body.code).toBe('hours.otherSource');
    expect((await agent.get('/api/monthly-hours/2026/9').expect(200)).body.rows[0].hasDailyEntries).toBe(true);
    // October has no daily entries, so totals are fine there.
    await agent.post(`/api/monthly-hours/2026/10/${placementA}`).send({ ...FULL_MONTH, normalHours: '216', workdaysWorked: 24 }).expect(201);
  });
});

describe('payroll', () => {
  it('pays a full month of totals exactly the salary, with every line explained', async () => {
    const { agent, placementA, workerId } = await company({ ...RULES, travelPayMode: 'PER_DAY_WORKED' });
    const route = await ctx.prisma.travelRoute.create({
      data: { companyId: (await ctx.prisma.assignment.findUniqueOrThrow({ where: { id: placementA } })).companyId, name: 'Route 1', amountPerDay: '20000' },
    });
    await ctx.prisma.assignment.update({ where: { id: placementA }, data: { travelRouteId: route.id } });
    await agent.post(`/api/monthly-hours/2026/9/${placementA}`).send(FULL_MONTH).expect(201);

    const payroll = (await agent.get('/api/payroll/2026/9').expect(200)).body;
    expect(payroll.total).toBe('8000000.00');
    const [w] = payroll.workers;
    expect(w).toMatchObject({
      worker: { id: workerId, lastName: 'Testov' },
      salary: { fromYear: 2026, fromMonth: 9, monthlySalary: '7500000' },
      source: 'TOTALS',
      total: '8000000.00',
      problems: [],
    });
    expect(w.parts).toHaveLength(1);
    expect(w.parts[0]).toMatchObject({
      ruleSetSiteName: null,
      rulesFrom: { year: 2026, month: 9 },
      placementIds: [placementA],
      places: { [placementA]: { siteName: 'Site A', from: '2026-09-01', until: null } },
    });
    expect(w.parts[0].result.hourlyRate).toMatchObject({ workingDays: { effective: 25 }, normalHoursPerDay: '9.00', rounded: '33333.33' });
    expect(w.parts[0].result.lines).toEqual([
      { type: 'HOURS', place: placementA, kind: 'NORMAL', hours: '225.00', multiplier: '1.00', amount: '7500000.00' },
      { type: 'TRAVEL_PER_DAY', place: placementA, route: 'Route 1', days: 25, amountPerDay: '20000.00', amount: '500000.00' },
    ]);
  });

  it('pays daily entries too, saying where the hours came from', async () => {
    const { company: c, agent, placementA, siteA } = await company();
    await dailyEntry(c.id, placementA, siteA, '2026-09-02');
    const [w] = (await agent.get('/api/payroll/2026/9').expect(200)).body.workers;
    expect(w).toMatchObject({ source: 'DAILY', total: '300000.00', problems: [] });
    expect(w.parts[0].places).toEqual({ [siteA]: { siteName: 'Site A', from: null, until: null } });
    expect(w.parts[0].result.summary).toMatchObject({ normalHours: '9.00', workdaysWorked: 1 });
  });

  it('pays a worker who moved to a site with its own rules in two parts', async () => {
    const { company: c, agent, siteB, workerId, placementA } = await company();
    await agent.post(`/api/workers/${workerId}/placements`).send({ siteId: siteB, from: '2026-09-16', shift: 'DAY' }).expect(204);
    const placementB = (await agent.get(`/api/workers/${workerId}`).expect(200)).body.placement.id as string;
    // Site B's own rules: 8-hour days, rounded to 500.
    const user = await createUser(ctx.prisma);
    const set = await ctx.prisma.payrollRuleSet.create({ data: { companyId: c.id, siteId: siteB } });
    await ctx.prisma.payrollRules.create({
      data: {
        companyId: c.id,
        ruleSetId: set.id,
        fromYear: 2026,
        fromMonth: 1,
        restWeekdays: [7],
        normalHoursPerDay: '8',
        overtimeMultiplier: '1.5',
        restDayMultiplier: '2',
        holidayMultiplier: '2',
        leavePaid: true,
        sickPaid: true,
        sickHoursPerDay: '8',
        travelDayPaid: false,
        travelPayMode: 'NONE',
        payRoundingStep: '500',
        setById: user.id,
      },
    });

    await agent.post(`/api/monthly-hours/2026/9/${placementA}`).send({ ...FULL_MONTH, normalHours: '100', workdaysWorked: 12 }).expect(201);
    // Placement B has no hours yet: missing data is never guessed.
    const missing = (await agent.get('/api/payroll/2026/9').expect(200)).body.workers[0];
    expect(missing).toMatchObject({ total: null, parts: [], problems: [{ code: 'placementWithoutHours', assignmentId: placementB, siteName: 'Site B', from: '2026-09-16' }] });

    // 96 h is 12 days × 8 h under site B's rules (the check uses them).
    await agent.post(`/api/monthly-hours/2026/9/${placementB}`).send({ ...FULL_MONTH, normalHours: '97', workdaysWorked: 12 }).expect(400);
    await agent.post(`/api/monthly-hours/2026/9/${placementB}`).send({ ...FULL_MONTH, normalHours: '96', workdaysWorked: 12 }).expect(201);
    const [w] = (await agent.get('/api/payroll/2026/9').expect(200)).body.workers;
    // A: 100 h × 7 500 000 ÷ (25 × 9) = 3 333 333.33 → 3 333 000. B: 96 h × 7 500 000 ÷ (25 × 8) = 3 600 000.
    expect(w.parts.map((p: { ruleSetSiteName: string | null; result: { total: string; hourlyRate: { rounded: string } } }) => [
      p.ruleSetSiteName,
      p.result.hourlyRate.rounded,
      p.result.total,
    ])).toEqual([
      [null, '33333.33', '3333000.00'],
      ['Site B', '37500.00', '3600000.00'],
    ]);
    expect(w.total).toBe('6933000.00');
  });

  it('shows what is missing instead of guessing', async () => {
    const { company: c, agent, siteA, placementA } = await company();
    const noSalary = await hire(agent, siteA, 'Unpaid');
    const noSalaryPlacement = (await agent.get(`/api/workers/${noSalary}`).expect(200)).body.placement.id;
    await agent.post(`/api/monthly-hours/2026/9/${noSalaryPlacement}`).send(FULL_MONTH).expect(201);
    await agent.post(`/api/monthly-hours/2026/9/${placementA}`).send(FULL_MONTH).expect(201);
    // Both sources for one worker-month can only come from outside the API; payroll still refuses to add them up.
    await dailyEntry(c.id, placementA, siteA, '2026-09-02');
    await hire(agent, siteA, 'Idle');

    const payroll = (await agent.get('/api/payroll/2026/9').expect(200)).body;
    expect(payroll.workers.map((w: { worker: { lastName: string }; problems: unknown[]; total: string | null }) => [w.worker.lastName, w.problems, w.total])).toEqual([
      ['Idle', [{ code: 'noHours' }, { code: 'noSalary' }], null],
      ['Testov', [{ code: 'twoSources' }], null],
      ['Unpaid', [{ code: 'noSalary' }], null],
    ]);
    expect(payroll.total).toBe('0.00');
  });

  it('shows totals that no longer fit after the rules changed', async () => {
    const { agent, placementA } = await company();
    await agent.post(`/api/monthly-hours/2026/9/${placementA}`).send(FULL_MONTH).expect(201);
    // Normal hours go down to 8 a day: 225 h no longer fits 25 days.
    await agent.put('/api/pay-rules/2026/9').send({ ...RULES, normalHoursPerDay: '8' }).expect(204);
    const [w] = (await agent.get('/api/payroll/2026/9').expect(200)).body.workers;
    expect(w).toMatchObject({
      total: null,
      problems: [{ code: 'totalsInvalid', issues: [{ siteName: 'Site A', problem: 'NORMAL_ABOVE_DAYS_WORKED' }] }],
    });
  });

  it('never shows pay to timekeepers or foremen, and shows project managers their own sites', async () => {
    const { company: c, agent, siteB, placementA } = await company();
    await agent.post(`/api/monthly-hours/2026/9/${placementA}`).send(FULL_MONTH).expect(201);
    await hire(agent, siteB, 'Elsewhere');
    for (const role of ['TIMEKEEPER', 'FOREMAN'] as const) {
      const field = await member(c.id, role);
      await field.agent.get('/api/payroll/2026/9').expect(403);
      await field.agent.get('/api/monthly-hours/2026/9').expect(403);
    }
    const pm = await member(c.id, 'PROJECT_MANAGER');
    await agent.post(`/api/sites/${siteB}/staff`).send({ userId: pm.user.id }).expect(204);
    const seen = (await pm.agent.get('/api/payroll/2026/9').expect(200)).body.workers;
    expect(seen.map((w: { worker: { lastName: string } }) => w.worker.lastName)).toEqual(['Elsewhere']);
    await pm.agent.get('/api/monthly-hours/2026/9').expect(403);
    await pm.agent.post(`/api/monthly-hours/2026/9/${placementA}`).send(FULL_MONTH).expect(403);
  });

  it("never shows or changes another company's hours or pay", async () => {
    const a = await company();
    const b = await company();
    await b.agent.post(`/api/monthly-hours/2026/9/${b.placementA}`).send(FULL_MONTH).expect(201);
    const res = await a.agent.post(`/api/monthly-hours/2026/9/${b.placementA}`).send({ ...FULL_MONTH, normalHours: '9', workdaysWorked: 1 }).expect(404);
    expect(res.body.code).toBe('placement.notFound');
    expect((await a.agent.get('/api/monthly-hours/2026/9').expect(200)).body.rows.map((r: { assignmentId: string }) => r.assignmentId)).toEqual([
      a.placementA,
    ]);
    const payroll = (await a.agent.get('/api/payroll/2026/9').expect(200)).body;
    expect(payroll.workers.map((w: { worker: { id: string } }) => w.worker.id)).toEqual([a.workerId]);
    expect(await ctx.prisma.monthlyHours.count()).toBe(1);
  });
});
