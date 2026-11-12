import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, memberOfNewCompany, paidCategories, resetDb, setUpPay, startApp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

// September 2026: Sept 1 is Independence Day and Sundays are rest days, so 25 working
// days: 11 on Sept 1–14 and 14 on Sept 15–30.
const RULES = {
  restWeekdays: [7],
  normalHoursPerDay: '8',
  overtimeMultiplier: '1.5',
  restDayMultiplier: '2',
  holidayMultiplier: '2',
  absence: {
    LEAVE: { paid: true, hoursPerDay: null },
    SICK: { paid: true, hoursPerDay: '8' },
    TRAVEL: { paid: false, hoursPerDay: null },
  },
  travelPayMode: 'NONE',
};

type Agent = Awaited<ReturnType<typeof memberOfNewCompany>>['agent'];

/** A company with pay rules from September 2026, a site and a worker on it from Sept 1, without a salary yet. */
async function company() {
  const owner = await memberOfNewCompany(ctx, 'OWNER');
  await setUpPay(owner.agent, RULES);
  const site = (await owner.agent.post('/api/sites').send({ name: 'Site A' }).expect(201)).body.id as string;
  const categories = await paidCategories(owner.agent);
  const worker = (
    await owner.agent
      .post('/api/workers')
      .send({ worker: { lastName: 'Testov', firstName: 'Test', categories }, placement: { siteId: site, from: '2026-09-01' } })
      .expect(201)
  ).body.id as string;
  const placement = (await owner.agent.get(`/api/workers/${worker}`).expect(200)).body.placement.id as string;
  return { ...owner, site, worker, placement };
}

const salary = (agent: Agent, workerId: string, from: string, monthlySalary: string, firmId?: string) =>
  agent.post(`/api/workers/${workerId}/salaries`).send({ from, monthlySalary, firmId });

/** Every September working day worked 8 hours, written directly: these tests are about pay. */
async function workTheMonth(companyId: string, assignmentId: string, siteId: string) {
  const user = await createUser(ctx.prisma);
  const period = await ctx.prisma.payrollPeriod.create({ data: { companyId, year: 2026, month: 9 } });
  const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`).filter(
    (d) => d !== '2026-09-01' && new Date(`${d}T00:00:00Z`).getUTCDay() !== 0,
  );
  await ctx.prisma.timesheetEntry.createMany({
    data: days.map((d) => ({
      companyId,
      periodId: period.id,
      assignmentId,
      siteId,
      date: new Date(`${d}T00:00:00Z`),
      status: 'WORKED' as const,
      hours: 8,
      createdById: user.id,
      updatedById: user.id,
    })),
  });
}

const totals = (from: string, until: string, normalHours: string, workdaysWorked: number) => ({
  from,
  until,
  normalHours,
  overtimeHours: '0',
  restDayHours: '0',
  holidayHours: '0',
  workdaysWorked,
  leaveDays: 0,
  sickDays: 0,
  travelDays: 0,
});

describe('salaries from a day', () => {
  it('pays a month split by a salary change in two parts, each at its own salary', async () => {
    const { company: c, agent, site, worker, placement } = await company();
    await salary(agent, worker, '2026-09-01', '5000000').expect(201);
    await salary(agent, worker, '2026-09-15', '7500000').expect(201);
    await workTheMonth(c.id, placement, site);

    const [w] = (await agent.get('/api/payroll/2026/9').expect(200)).body.workers;
    expect(w.problems).toEqual([]);
    expect(w.parts.map((p: { salary: unknown; days: unknown }) => [p.salary, p.days])).toEqual([
      [{ from: '2026-09-01', monthlySalary: '5000000' }, { from: '2026-09-01', until: '2026-09-14' }],
      [{ from: '2026-09-15', monthlySalary: '7500000' }, { from: '2026-09-15', until: '2026-09-30' }],
    ]);
    const [first, second] = w.parts.map((p: { result: unknown }) => p.result);
    // Both parts share the month's 25 working days: 11/25 of 5 000 000 and 14/25 of 7 500 000.
    expect(first.hourlyRate).toMatchObject({ workingDays: { effective: 25 }, rounded: '25000.00' });
    expect(first.lines).toEqual([expect.objectContaining({ kind: 'NORMAL', hours: '88.00', amount: '2200000.00' })]);
    expect(second.hourlyRate).toMatchObject({ workingDays: { effective: 25 }, rounded: '37500.00' });
    expect(second.lines).toEqual([expect.objectContaining({ kind: 'NORMAL', hours: '112.00', amount: '4200000.00' })]);
    expect(w.total).toBe('6400000.00');
    // The worker's salary of the month is the one their last day is paid at.
    expect(w.salary).toEqual({ from: '2026-09-15', monthlySalary: '7500000' });
  });

  it('pays the whole month at a salary from the 1st, and corrects a salary by a newer one from the same day', async () => {
    const { company: c, agent, site, worker, placement } = await company();
    await salary(agent, worker, '2026-09-01', '5000000').expect(201);
    await salary(agent, worker, '2026-09-15', '9000000').expect(201);
    await salary(agent, worker, '2026-09-15', '5000000').expect(201);
    await workTheMonth(c.id, placement, site);

    // The correction makes both halves the same salary, so the month is one part again.
    const [w] = (await agent.get('/api/payroll/2026/9').expect(200)).body.workers;
    expect(w.parts.map((p: { days: unknown }) => p.days)).toEqual([{ from: '2026-09-01', until: '2026-09-30' }]);
    expect(w.total).toBe('5000000.00');
    const history = (await agent.get(`/api/workers/${worker}/salaries`).expect(200)).body;
    expect(history.map((h: { from: string; monthlySalary: string; corrected: boolean }) => [h.from, h.monthlySalary, h.corrected])).toEqual([
      ['2026-09-15', '5000000', false],
      ['2026-09-15', '9000000', true],
      ['2026-09-01', '5000000', false],
    ]);
  });

  it("can't pay days of a placement before the worker's first salary", async () => {
    const { company: c, agent, site, worker, placement } = await company();
    await salary(agent, worker, '2026-09-15', '7500000').expect(201);
    await workTheMonth(c.id, placement, site);

    const [w] = (await agent.get('/api/payroll/2026/9').expect(200)).body.workers;
    expect(w.problems).toEqual([{ code: 'noSalary' }]);
    expect(w.total).toBeNull();
    // A salary for the days before fixes it.
    await salary(agent, worker, '2026-09-01', '5000000').expect(201);
    expect((await agent.get('/api/payroll/2026/9').expect(200)).body.workers[0].total).toBe('6400000.00');
  });

  it('accepts a salary from a day that has not come yet, which changes nothing before it', async () => {
    const { company: c, agent, site, worker, placement } = await company();
    await salary(agent, worker, '2026-09-01', '5000000').expect(201);
    await salary(agent, worker, '2031-03-10', '9000000').expect(201);
    await workTheMonth(c.id, placement, site);
    const [w] = (await agent.get('/api/payroll/2026/9').expect(200)).body.workers;
    expect(w.parts).toHaveLength(1);
    expect(w.total).toBe('5000000.00');
  });

  it('takes monthly totals per part, and counts totals from before a salary change for nothing', async () => {
    const { agent, worker, placement } = await company();
    const url = `/api/monthly-hours/2026/9/${placement}`;
    await salary(agent, worker, '2026-09-01', '5000000').expect(201);
    await agent.post(url).send(totals('2026-09-01', '2026-09-30', '200', 25)).expect(201);
    await salary(agent, worker, '2026-09-15', '7500000').expect(201);

    let [w] = (await agent.get('/api/payroll/2026/9').expect(200)).body.workers;
    expect(w.problems).toEqual([
      { code: 'placementWithoutHours', assignmentId: placement, siteName: 'Site A', from: '2026-09-01', until: '2026-09-14' },
      { code: 'placementWithoutHours', assignmentId: placement, siteName: 'Site A', from: '2026-09-15', until: '2026-09-30' },
    ]);
    const month = (await agent.get('/api/monthly-hours/2026/9').expect(200)).body;
    expect(month.rows.map((r: { part: unknown; outdated: unknown[] }) => [r.part, r.outdated.length])).toEqual([
      [{ from: '2026-09-01', until: '2026-09-14' }, 1],
      [{ from: '2026-09-15', until: '2026-09-30' }, 0],
    ]);

    expect((await agent.post(url).send(totals('2026-09-01', '2026-09-30', '200', 25)).expect(409)).body.code).toBe('monthlyHours.partChanged');
    await agent.post(url).send(totals('2026-09-01', '2026-09-14', '88', 11)).expect(201);
    await agent.post(url).send(totals('2026-09-15', '2026-09-30', '112', 14)).expect(201);
    [w] = (await agent.get('/api/payroll/2026/9').expect(200)).body.workers;
    expect(w.problems).toEqual([]);
    expect(w.parts.map((p: { result: { total: string } }) => p.result.total)).toEqual(['2200000.00', '4200000.00']);
  });

  it('refuses a salary whose days reach a locked month', async () => {
    const { company: c, agent, worker } = await company();
    await salary(agent, worker, '2026-09-01', '5000000').expect(201);
    await salary(agent, worker, '2026-11-10', '6000000').expect(201);
    await ctx.prisma.payrollPeriod.create({
      data: { companyId: c.id, year: 2026, month: 10, status: 'LOCKED', lockedAt: new Date(), lockedById: (await createUser(ctx.prisma)).id },
    });

    // From mid-September it would be paid until 9 November, through locked October.
    expect((await salary(agent, worker, '2026-09-15', '5500000').expect(409)).body.code).toBe('period.locked');
    expect((await salary(agent, worker, '2026-10-20', '5500000').expect(409)).body.code).toBe('period.locked');
    // From 5 November it is paid until the 9th: only November, which is open.
    await salary(agent, worker, '2026-11-05', '5500000').expect(201);
    await salary(agent, worker, '2026-11-20', '6500000').expect(201);
  });

  it("splits a firm's days only where that firm's own salary changes", async () => {
    const { company: c, agent, site, worker, placement } = await company();
    const firm = async (name: string) => (await agent.post('/api/firms').send({ name, type: 'OWN' }).expect(201)).body.id as string;
    const own = await firm('Firm A');
    const other = await firm('Firm B');
    await agent.put('/api/firms/settings').send({ enabled: true }).expect(204);
    await agent.put(`/api/workers/${worker}/placements/${placement}/firm`).send({ firmId: own }).expect(204);
    await salary(agent, worker, '2026-09-01', '5000000', own).expect(201);
    // A salary in a firm the worker has no days with this month.
    await salary(agent, worker, '2026-09-15', '9000000', other).expect(201);
    await workTheMonth(c.id, placement, site);

    const [w] = (await agent.get('/api/payroll/2026/9').expect(200)).body.workers;
    expect(w.problems).toEqual([]);
    expect(w.parts.map((p: { days: unknown; salary: unknown }) => [p.days, p.salary])).toEqual([
      [{ from: '2026-09-01', until: '2026-09-30' }, { from: '2026-09-01', monthlySalary: '5000000' }],
    ]);
    expect(w.total).toBe('5000000.00');
  });

  it("never adds a salary to another company's worker", async () => {
    const a = await company();
    const b = await company();
    await salary(b.agent, a.worker, '2026-09-15', '7500000').expect(404);
    expect(await ctx.prisma.salary.count()).toBe(0);
  });
});
