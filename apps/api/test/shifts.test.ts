import type { Role } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, createUser, loginAs, memberOfNewCompany, resetDb, startApp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

// September 2026: Sept 1 is Independence Day and Sundays are rest days, so 25 working
// days: 11 on Sept 1–14 and 14 on Sept 15–30.
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

type Agent = Awaited<ReturnType<typeof memberOfNewCompany>>['agent'];

/** A company with pay rules from September 2026, two sites, a night shift and a worker on each site. */
async function company() {
  const owner = await memberOfNewCompany(ctx, 'OWNER');
  await owner.agent.put('/api/pay-rules/2026/9').send(RULES).expect(204);
  const siteA = (await owner.agent.post('/api/sites').send({ name: 'Site A' }).expect(201)).body.id as string;
  const siteB = (await owner.agent.post('/api/sites').send({ name: 'Site B' }).expect(201)).body.id as string;
  const night = (await owner.agent.post('/api/shifts').send({ name: 'Night', normalHoursPerDay: '10' }).expect(201)).body.id as string;
  const workerA = await hire(owner.agent, siteA, 'Alpha');
  const workerB = await hire(owner.agent, siteB, 'Beta');
  await owner.agent.post(`/api/workers/${workerA}/salaries`).send({ fromYear: 2026, fromMonth: 9, monthlySalary: '7500000' }).expect(201);
  const placementA = (await owner.agent.get(`/api/workers/${workerA}`).expect(200)).body.placement.id as string;
  return { ...owner, siteA, siteB, night, workerA, workerB, placementA };
}

async function hire(agent: Agent, siteId: string, lastName: string) {
  const res = await agent
    .post('/api/workers')
    .send({ worker: { lastName, firstName: 'Test', employmentType: 'DIRECT' }, placement: { siteId, from: '2026-09-01' } })
    .expect(201);
  return res.body.id as string;
}

async function member(companyId: string, role: Role, siteId?: string, owner?: Agent) {
  const user = await createUser(ctx.prisma);
  await addMember(ctx.prisma, user.id, companyId, role);
  if (siteId && owner) await owner.post(`/api/sites/${siteId}/staff`).send({ userId: user.id }).expect(204);
  return { user, agent: await loginAs(ctx.app, user.email!) };
}

/** Every September working day worked at `hours(date)`, written directly: these tests are about pay. */
async function workTheMonth(companyId: string, assignmentId: string, siteId: string, hours: (date: string) => number) {
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
      hours: hours(d),
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

describe('company shifts', () => {
  it('lets owners and admins define shifts, fixing their hours once a worker has had one', async () => {
    const { company: c, agent, night, workerA } = await company();
    const accountant = await member(c.id, 'ACCOUNTANT');
    await accountant.agent.post('/api/shifts').send({ name: 'Day', normalHoursPerDay: '8' }).expect(403);
    expect((await agent.post('/api/shifts').send({ name: 'night', normalHoursPerDay: '11' }).expect(409)).body.code).toBe('shift.nameTaken');

    await agent.patch(`/api/shifts/${night}`).send({ normalHoursPerDay: '10.5' }).expect(204);
    await agent.post('/api/worker-shifts').send({ workerIds: [workerA], shiftId: night, from: '2026-09-15' }).expect(201);
    expect((await agent.patch(`/api/shifts/${night}`).send({ normalHoursPerDay: '10' }).expect(409)).body.code).toBe('shift.inUse');
    await agent.patch(`/api/shifts/${night}`).send({ name: 'Night shift', isActive: false }).expect(204);

    expect((await accountant.agent.get('/api/shifts').expect(200)).body).toEqual([
      { id: night, name: 'Night shift', normalHoursPerDay: '10.5', isActive: false, inUse: true },
    ]);
    const log = await ctx.prisma.auditLog.findMany({ where: { action: 'shift.update' }, orderBy: { createdAt: 'asc' } });
    expect(log.map((l) => l.data)).toEqual([
      { changes: { normalHoursPerDay: { from: '10', to: '10.5' } } },
      { changes: { name: { from: 'Night', to: 'Night shift' }, isActive: { from: true, to: false } } },
    ]);
    // An inactive shift isn't given any more.
    const res = await agent.post('/api/worker-shifts').send({ workerIds: [workerA], shiftId: night, from: '2026-10-01' }).expect(409);
    expect(res.body.code).toBe('shift.inactive');
  });
});

describe('worker shifts', () => {
  it('lets owners, admins and accountants give shifts, timekeepers only on their sites, many at once', async () => {
    const { company: c, agent, siteA, night, workerA, workerB } = await company();
    const accountant = await member(c.id, 'ACCOUNTANT');
    const timekeeper = await member(c.id, 'TIMEKEEPER', siteA, agent);
    const foreman = await member(c.id, 'FOREMAN');
    const pm = await member(c.id, 'PROJECT_MANAGER', siteA, agent);

    const both = { workerIds: [workerA, workerB], shiftId: night, from: '2026-09-15' };
    // All or nothing: the timekeeper doesn't see the worker on site B.
    await timekeeper.agent.post('/api/worker-shifts').send(both).expect(404);
    expect(await ctx.prisma.workerShift.count()).toBe(0);
    await foreman.agent.post('/api/worker-shifts').send(both).expect(403);
    await pm.agent.post('/api/worker-shifts').send(both).expect(403);

    expect((await timekeeper.agent.post('/api/worker-shifts').send({ ...both, workerIds: [workerA] }).expect(201)).body).toEqual({
      added: 1,
      unchanged: 0,
    });
    // Worker A is already on nights then; worker B gets them.
    expect((await accountant.agent.post('/api/worker-shifts').send({ ...both, from: '2026-09-20' }).expect(201)).body).toEqual({
      added: 1,
      unchanged: 1,
    });
    expect((await accountant.agent.post('/api/worker-shifts').send(both).expect(409)).body.code).toBe('workerShift.dayTaken');
    // Back to no shift.
    await accountant.agent.post('/api/worker-shifts').send({ workerIds: [workerA], shiftId: null, from: '2026-10-01' }).expect(201);

    const history = (await timekeeper.agent.get(`/api/workers/${workerA}/shifts`).expect(200)).body;
    expect(history.map((h: { from: string; shift: { name: string } | null }) => [h.from, h.shift?.name ?? null])).toEqual([
      ['2026-09-15', 'Night'],
      ['2026-10-01', null],
    ]);
    expect(history[0].setBy.fullName).toBe(timekeeper.user.fullName);
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'workerShift.add', entityId: workerB } });
    expect(log.data).toMatchObject({ from: '2026-09-20', shift: { id: night, name: 'Night', normalHoursPerDay: '10' }, before: null });
  });

  it('lets only owners and admins correct or remove a row, audited with old and new values', async () => {
    const { company: c, agent, night, workerA } = await company();
    const accountant = await member(c.id, 'ACCOUNTANT');
    await agent.post('/api/worker-shifts').send({ workerIds: [workerA], shiftId: night, from: '2026-09-15' }).expect(201);
    const [row] = (await agent.get(`/api/workers/${workerA}/shifts`).expect(200)).body;
    const url = `/api/workers/${workerA}/shifts/${row.id}`;

    await accountant.agent.put(url).send({ shiftId: night, from: '2026-09-10' }).expect(403);
    await accountant.agent.delete(url).expect(403);
    expect((await agent.put(url).send({ shiftId: night, from: '2026-09-15' }).expect(409)).body.code).toBe('workerShift.unchanged');
    await agent.put(url).send({ shiftId: night, from: '2026-09-10' }).expect(204);
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'workerShift.correct' } });
    expect(log.data).toMatchObject({
      from: { from: '2026-09-15', shiftId: night, name: 'Night' },
      to: { from: '2026-09-10', shiftId: night, name: 'Night' },
    });
    await agent.delete(url).expect(204);
    expect(await ctx.prisma.workerShift.count()).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'workerShift.remove' } })).toBe(1);
  });

  it('shows the shift today in the workers list, also to timekeepers', async () => {
    const { company: c, agent, siteA, night, workerA } = await company();
    const timekeeper = await member(c.id, 'TIMEKEEPER', siteA, agent);
    await agent.post('/api/worker-shifts').send({ workerIds: [workerA], shiftId: night, from: '2026-09-15' }).expect(201);
    const list = (await timekeeper.agent.get('/api/workers').expect(200)).body;
    expect(list.map((w: { lastName: string; shift: unknown }) => [w.lastName, w.shift])).toEqual([
      ['Alpha', { id: night, name: 'Night', normalHoursPerDay: '10' }],
    ]);
  });

  it('never changes a locked month', async () => {
    const { company: c, agent, user, night, workerA } = await company();
    await agent.post('/api/worker-shifts').send({ workerIds: [workerA], shiftId: night, from: '2026-10-05' }).expect(201);
    const [row] = (await agent.get(`/api/workers/${workerA}/shifts`).expect(200)).body;
    await ctx.prisma.payrollPeriod.create({
      data: { companyId: c.id, year: 2026, month: 9, status: 'LOCKED', lockedAt: new Date(), lockedById: user.id },
    });

    const add = await agent.post('/api/worker-shifts').send({ workerIds: [workerA], shiftId: night, from: '2026-09-20' }).expect(409);
    expect(add.body.code).toBe('period.locked');
    // Moving the October row into September would change September.
    const url = `/api/workers/${workerA}/shifts/${row.id}`;
    expect((await agent.put(url).send({ shiftId: night, from: '2026-09-28' }).expect(409)).body.code).toBe('period.locked');
    await agent.put(url).send({ shiftId: night, from: '2026-10-01' }).expect(204);
  });

  it("never shows, gives or changes another company's shifts", async () => {
    const a = await company();
    const b = await company();
    await a.agent.post('/api/worker-shifts').send({ workerIds: [a.workerA], shiftId: a.night, from: '2026-09-15' }).expect(201);
    const [row] = (await a.agent.get(`/api/workers/${a.workerA}/shifts`).expect(200)).body;

    expect((await b.agent.get('/api/shifts').expect(200)).body.map((s: { id: string }) => s.id)).toEqual([b.night]);
    await b.agent.patch(`/api/shifts/${a.night}`).send({ name: 'Mine' }).expect(404);
    await b.agent.post('/api/worker-shifts').send({ workerIds: [b.workerA], shiftId: a.night, from: '2026-09-15' }).expect(404);
    await b.agent.post('/api/worker-shifts').send({ workerIds: [a.workerA], shiftId: b.night, from: '2026-09-16' }).expect(404);
    await b.agent.get(`/api/workers/${a.workerA}/shifts`).expect(404);
    await b.agent.put(`/api/workers/${a.workerA}/shifts/${row.id}`).send({ shiftId: null, from: '2026-09-15' }).expect(404);
    await b.agent.put(`/api/workers/${b.workerA}/shifts/${row.id}`).send({ shiftId: null, from: '2026-09-15' }).expect(404);
    await b.agent.delete(`/api/workers/${b.workerA}/shifts/${row.id}`).expect(404);
    expect(await ctx.prisma.workerShift.count({ where: { companyId: a.company.id } })).toBe(1);
  });
});

describe('pay by shift', () => {
  it("pays a month split by a shift change in two parts, each at its shift's normal hours, adding up to the salary", async () => {
    const { company: c, agent, siteA, night, workerA, placementA } = await company();
    await agent.post('/api/worker-shifts').send({ workerIds: [workerA], shiftId: night, from: '2026-09-15' }).expect(201);
    // Normal hours on the rule set (9) before the change, 10 on nights after it; 10 hours before is 1 hour of overtime.
    await workTheMonth(c.id, placementA, siteA, (d) => (d < '2026-09-15' ? (d === '2026-09-02' ? 10 : 9) : 10));

    const [worker] = (await agent.get('/api/payroll/2026/9').expect(200)).body.workers;
    expect(worker.problems).toEqual([]);
    expect(worker.parts.map((p: { shift: unknown; days: unknown }) => [p.shift, p.days])).toEqual([
      [null, { from: '2026-09-01', until: '2026-09-14' }],
      [{ name: 'Night', normalHoursPerDay: '10' }, { from: '2026-09-15', until: '2026-09-30' }],
    ]);
    const [first, second] = worker.parts.map((p: { result: unknown }) => p.result);
    expect(first.hourlyRate).toMatchObject({ normalHoursPerDay: '9.00', workingDays: { effective: 25 } });
    expect(first.lines).toEqual([
      expect.objectContaining({ kind: 'NORMAL', hours: '99.00', amount: '3300000.00' }),
      expect.objectContaining({ kind: 'OVERTIME', hours: '1.00', multiplier: '1.50', amount: '50000.00' }),
    ]);
    expect(second.hourlyRate).toMatchObject({ normalHoursPerDay: '10.00', workingDays: { effective: 25 }, rounded: '30000.00' });
    expect(second.lines).toEqual([expect.objectContaining({ kind: 'NORMAL', hours: '140.00', amount: '4200000.00' })]);
    expect(worker.total).toBe('7550000.00');
  });

  it('takes monthly totals per part, and counts totals from before a shift change for nothing', async () => {
    const { agent, night, workerA, placementA } = await company();
    const url = `/api/monthly-hours/2026/9/${placementA}`;
    await agent.post(url).send(totals('2026-09-01', '2026-09-30', '225', 25)).expect(201);
    await agent.post('/api/worker-shifts').send({ workerIds: [workerA], shiftId: night, from: '2026-09-15' }).expect(201);

    let [worker] = (await agent.get('/api/payroll/2026/9').expect(200)).body.workers;
    expect(worker.source).toBe('TOTALS');
    expect(worker.problems).toEqual([
      { code: 'placementWithoutHours', assignmentId: placementA, siteName: 'Site A', from: '2026-09-01', until: '2026-09-14' },
      { code: 'placementWithoutHours', assignmentId: placementA, siteName: 'Site A', from: '2026-09-15', until: '2026-09-30' },
    ]);
    const month = (await agent.get('/api/monthly-hours/2026/9').expect(200)).body;
    const rows = month.rows.filter((r: { assignmentId: string }) => r.assignmentId === placementA);
    expect(rows.map((r: { part: unknown; shift: { name: string } | null; outdated: unknown[] }) => [r.part, r.shift?.name ?? null, r.outdated.length])).toEqual([
      [{ from: '2026-09-01', until: '2026-09-14' }, null, 1],
      [{ from: '2026-09-15', until: '2026-09-30' }, 'Night', 0],
    ]);

    // The whole month is no part any more; each part is checked against its own days and shift.
    expect((await agent.post(url).send(totals('2026-09-01', '2026-09-30', '225', 25)).expect(409)).body.code).toBe(
      'monthlyHours.partChanged',
    );
    const tooMany = await agent.post(url).send(totals('2026-09-15', '2026-09-30', '150', 15)).expect(400);
    expect(tooMany.body.issues).toEqual([{ path: 'workdaysWorked', message: 'validation.daysAboveWorkingDays' }]);
    await agent.post(url).send(totals('2026-09-01', '2026-09-14', '99', 11)).expect(201);
    await agent.post(url).send(totals('2026-09-15', '2026-09-30', '140', 14)).expect(201);

    [worker] = (await agent.get('/api/payroll/2026/9').expect(200)).body.workers;
    expect(worker.problems).toEqual([]);
    expect(worker.parts.map((p: { result: { total: string } }) => p.result.total)).toEqual(['3300000.00', '4200000.00']);
    expect(worker.total).toBe('7500000.00');
  });
});
