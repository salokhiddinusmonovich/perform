import { randomUUID } from 'node:crypto';
import type { Role } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, createPlan, createUser, loginAs, memberOfNewCompany, resetDb, startApp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

type Agent = Awaited<ReturnType<typeof memberOfNewCompany>>['agent'];

// September 2026: Sept 1 is Independence Day, Sundays are rest days, 9-hour days.
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

/**
 * A company with the Timesheet module and pay rules from September 2026: Site A with
 * Teams A and B, Site B, and a worker placed on Site A / Team A with a salary.
 */
async function company({ timesheetModule = true } = {}) {
  const owner = await memberOfNewCompany(ctx, 'OWNER');
  const plan = await createPlan(ctx.prisma, { timesheetModule });
  await ctx.prisma.company.update({ where: { id: owner.company.id }, data: { planId: plan.id } });
  await owner.agent.put('/api/pay-rules/2026/9').send(RULES).expect(204);
  const siteA = (await owner.agent.post('/api/sites').send({ name: 'Site A' }).expect(201)).body.id as string;
  const siteB = (await owner.agent.post('/api/sites').send({ name: 'Site B' }).expect(201)).body.id as string;
  const teamA = (await owner.agent.post('/api/teams').send({ siteId: siteA, name: 'Team A' }).expect(201)).body.id as string;
  const teamB = (await owner.agent.post('/api/teams').send({ siteId: siteA, name: 'Team B' }).expect(201)).body.id as string;
  const workerId = await hire(owner.agent, siteA, teamA, 'Testov');
  await owner.agent.post(`/api/workers/${workerId}/salaries`).send({ fromYear: 2026, fromMonth: 9, monthlySalary: '7500000' }).expect(201);
  return { ...owner, siteA, siteB, teamA, teamB, workerId };
}

async function hire(agent: Agent, siteId: string, teamId: string | null, lastName: string, from = '2026-09-01') {
  const res = await agent
    .post('/api/workers')
    .send({ worker: { lastName, firstName: 'Test', employmentType: 'DIRECT' }, placement: { siteId, teamId, from, shift: 'DAY' } })
    .expect(201);
  return res.body.id as string;
}

async function member(companyId: string, role: Role) {
  const user = await createUser(ctx.prisma);
  await addMember(ctx.prisma, user.id, companyId, role);
  return { user, agent: await loginAs(ctx.app, user.email!) };
}

const entryUrl = (id: string) => `/api/timesheet/entries/${id}`;

describe('daily hour entry', () => {
  it('creates, retries, changes and removes an entry by its client-made id, refusing stale versions', async () => {
    const { agent, siteA, teamA, workerId } = await company();
    const id = randomUUID();
    const cell = { workerId, siteId: siteA, teamId: teamA, date: '2026-09-02' };

    const created = (await agent.put(entryUrl(id)).send({ ...cell, status: 'WORKED', hours: '9' }).expect(200)).body;
    expect(created).toMatchObject({ id, date: '2026-09-02', status: 'WORKED', hours: '9', version: 1 });
    // A retry of the same write (the phone never got the answer) changes nothing.
    const retried = (await agent.put(entryUrl(id)).send({ ...cell, status: 'WORKED', hours: '9,0' }).expect(200)).body;
    expect(retried.version).toBe(1);

    const changed = (await agent.put(entryUrl(id)).send({ ...cell, status: 'WORKED', hours: '7.5', version: 1 }).expect(200)).body;
    expect(changed).toMatchObject({ hours: '7.5', version: 2 });
    // Another phone still has version 1.
    const stale = await agent.put(entryUrl(id)).send({ ...cell, status: 'SICK', version: 1 }).expect(409);
    expect(stale.body).toMatchObject({ code: 'timesheet.staleVersion', current: { hours: '7.5', version: 2 } });
    // Creating without a version means "I have never seen it".
    expect((await agent.put(entryUrl(id)).send({ ...cell, status: 'SICK' }).expect(409)).body.code).toBe('timesheet.staleVersion');

    expect((await agent.delete(`${entryUrl(id)}?version=1`).expect(409)).body.code).toBe('timesheet.staleVersion');
    await agent.delete(`${entryUrl(id)}?version=2`).expect(204);
    await agent.delete(`${entryUrl(id)}?version=2`).expect(204);
    expect(await ctx.prisma.timesheetEntry.count()).toBe(0);
    // A change to an entry that was removed meanwhile is refused, not silently re-created.
    const gone = await agent.put(entryUrl(id)).send({ ...cell, status: 'WORKED', hours: '9', version: 2 }).expect(409);
    expect(gone.body).toMatchObject({ code: 'timesheet.staleVersion', current: null });

    const log = await ctx.prisma.auditLog.findMany({ where: { entityType: 'TimesheetEntry' }, orderBy: { createdAt: 'asc' } });
    expect(log.map((l) => [l.action, l.data])).toEqual([
      ['timesheetEntry.create', expect.objectContaining({ workerId, date: '2026-09-02', to: { status: 'WORKED', hours: '9', note: null } })],
      ['timesheetEntry.update', expect.objectContaining({ from: expect.objectContaining({ hours: '9' }), to: expect.objectContaining({ hours: '7.5' }) })],
      ['timesheetEntry.delete', expect.objectContaining({ from: expect.objectContaining({ hours: '7.5' }) })],
    ]);
  });

  it('validates the entry and the worker’s whole day', async () => {
    const { agent, siteA, siteB, teamA, teamB, workerId } = await company();
    const put = (body: Record<string, unknown>, id = randomUUID()) => agent.put(entryUrl(id)).send(body);
    const day = { workerId, siteId: siteA, teamId: teamA, date: '2026-09-03' };

    const noHours = await put({ ...day, status: 'WORKED' }).expect(400);
    expect(noHours.body.issues).toEqual([{ path: 'hours', message: 'validation.required' }]);
    expect((await put({ ...day, status: 'WORKED', hours: '24.5' }).expect(400)).body.issues).toEqual([
      { path: 'hours', message: 'validation.dayHoursRange' },
    ]);
    expect((await put({ ...day, status: 'OFF' }).expect(400)).body.issues[0].path).toBe('status');

    // A day split between two teams and another site.
    await put({ ...day, status: 'WORKED', hours: '6' }).expect(200);
    await put({ ...day, teamId: teamB, status: 'WORKED', hours: '3' }).expect(200);
    await put({ ...day, siteId: siteB, teamId: null, status: 'WORKED', hours: '2' }).expect(200);
    expect((await put({ ...day, siteId: siteB, teamId: null, status: 'WORKED', hours: '1' }).expect(409)).body).toMatchObject({
      code: 'timesheet.entryExists',
      current: { hours: '2' },
    });
    expect((await put({ ...day, teamId: null, status: 'WORKED', hours: '14' }).expect(409)).body.code).toBe('timesheet.dayTooManyHours');
    // An absence is the whole day.
    expect((await put({ ...day, teamId: null, status: 'SICK' }).expect(409)).body.code).toBe('timesheet.wholeDay');
    await put({ ...day, date: '2026-09-04', status: 'SICK' }).expect(200);
    expect((await put({ ...day, date: '2026-09-04', teamId: teamB, status: 'WORKED', hours: '2' }).expect(409)).body.code).toBe(
      'timesheet.wholeDay',
    );

    // An id belongs to one cell.
    const id = randomUUID();
    await put({ ...day, date: '2026-09-05', status: 'WORKED', hours: '9' }, id).expect(200);
    expect((await put({ ...day, date: '2026-09-07', status: 'WORKED', hours: '9', version: 1 }, id).expect(409)).body.code).toBe(
      'timesheet.entryMismatch',
    );

    // Not employed yet, a day still to come, a closed team.
    const late = await hire(agent, siteA, teamA, 'Late', '2026-09-10');
    expect((await put({ ...day, workerId: late, status: 'WORKED', hours: '9' }).expect(409)).body.code).toBe('timesheet.notEmployed');
    expect((await put({ ...day, date: '2099-01-02', status: 'WORKED', hours: '9' }).expect(409)).body.code).toBe('timesheet.futureDay');
    const closed = (await agent.post('/api/teams').send({ siteId: siteA, name: 'Closed' }).expect(201)).body.id as string;
    await agent.patch(`/api/teams/${closed}`).send({ isActive: false }).expect(204);
    expect((await put({ ...day, teamId: closed, status: 'WORKED', hours: '1' }).expect(409)).body.code).toBe('team.inactive');
  });

  it('keeps one source of hours per worker-month', async () => {
    const { agent, siteA, teamA, workerId } = await company();
    const placement = (await agent.get(`/api/workers/${workerId}`).expect(200)).body.placement.id as string;
    const totals = {
      normalHours: '9', overtimeHours: '0', restDayHours: '0', holidayHours: '0',
      workdaysWorked: 1, leaveDays: 0, sickDays: 0, travelDays: 0,
    };
    await agent.post(`/api/monthly-hours/2026/9/${placement}`).send(totals).expect(201);
    const day = { workerId, siteId: siteA, teamId: teamA, date: '2026-09-02', status: 'WORKED', hours: '9' };
    expect((await agent.put(entryUrl(randomUUID())).send(day).expect(409)).body.code).toBe('hours.monthlyTotalsEntered');
    // October has no totals.
    await agent.put(entryUrl(randomUUID())).send({ ...day, date: '2026-10-01' }).expect(200);
    const grid = (await agent.get(`/api/timesheet/2026/9?siteId=${siteA}`).expect(200)).body;
    expect(grid.rows[0]).toMatchObject({ hasMonthlyTotals: true });
  });

  it('refuses every change in a locked month', async () => {
    const { agent, user, company: c, siteA, teamA, workerId } = await company();
    const id = randomUUID();
    const day = { workerId, siteId: siteA, teamId: teamA, date: '2026-09-02', status: 'WORKED', hours: '9' };
    await agent.put(entryUrl(id)).send(day).expect(200);
    await ctx.prisma.payrollPeriod.update({
      where: { companyId_year_month: { companyId: c.id, year: 2026, month: 9 } },
      data: { status: 'LOCKED', lockedAt: new Date(), lockedById: user.id },
    });

    expect((await agent.put(entryUrl(id)).send({ ...day, hours: '8', version: 1 }).expect(409)).body.code).toBe('period.locked');
    expect((await agent.put(entryUrl(randomUUID())).send({ ...day, date: '2026-09-03' }).expect(409)).body.code).toBe('period.locked');
    expect((await agent.delete(`${entryUrl(id)}?version=1`).expect(409)).body.code).toBe('period.locked');
    const grid = (await agent.get(`/api/timesheet/2026/9?siteId=${siteA}`).expect(200)).body;
    expect(grid).toMatchObject({ locked: true });
    expect(grid.rows[0].canEnter).toBe(false);
  });

  it('shows a site’s month with every team a worker worked in, the calendar and employment', async () => {
    const { agent, siteA, siteB, teamA, teamB, workerId } = await company();
    const late = await hire(agent, siteA, null, 'Late', '2026-09-10');
    const elsewhere = await hire(agent, siteB, null, 'Elsewhere');
    await agent.put(entryUrl(randomUUID())).send({ workerId, siteId: siteA, teamId: teamB, date: '2026-09-02', status: 'WORKED', hours: '4' }).expect(200);
    await agent.put(entryUrl(randomUUID())).send({ workerId: elsewhere, siteId: siteA, teamId: null, date: '2026-09-02', status: 'WORKED', hours: '2' }).expect(200);

    const grid = (await agent.get(`/api/timesheet/2026/9?siteId=${siteA}`).expect(200)).body;
    expect(grid).toMatchObject({ year: 2026, month: 9, site: { id: siteA, name: 'Site A', isActive: true }, locked: false });
    expect(grid.calendar).toHaveLength(30);
    expect(grid.calendar[0]).toEqual({ date: '2026-09-01', kind: 'HOLIDAY' });
    expect(grid.calendar[5]).toEqual({ date: '2026-09-06', kind: 'REST_DAY' });
    expect(
      grid.rows.map((r: { worker: { lastName: string }; teamId: string | null; entries: unknown[] }) => [r.worker.lastName, r.teamId, r.entries.length]),
    ).toEqual([
      ['Elsewhere', null, 1],
      ['Late', null, 0],
      ['Testov', teamA, 0],
      ['Testov', teamB, 1],
    ]);
    const lateRow = grid.rows.find((r: { worker: { id: string } }) => r.worker.id === late);
    expect(lateRow).toMatchObject({ employed: [{ from: '2026-09-10', until: null }], canEnter: true, hasMonthlyTotals: false });
    // Personal data never comes with the grid.
    expect(Object.keys(lateRow.worker).sort()).toEqual(['firstName', 'id', 'lastName', 'patronymic', 'position']);
  });
});

describe('who enters hours', () => {
  it('lets timekeepers enter on their sites by default, and foremen on their teams once Settings allow', async () => {
    const { agent, company: c, siteA, siteB, teamA, teamB, workerId } = await company();
    const timekeeper = await member(c.id, 'TIMEKEEPER');
    const foreman = await member(c.id, 'FOREMAN');
    const accountant = await member(c.id, 'ACCOUNTANT');
    const pm = await member(c.id, 'PROJECT_MANAGER');
    await agent.post(`/api/sites/${siteA}/staff`).send({ userId: timekeeper.user.id }).expect(204);
    await agent.post(`/api/sites/${siteA}/staff`).send({ userId: pm.user.id }).expect(204);
    await agent.post(`/api/teams/${teamA}/foremen`).send({ userId: foreman.user.id }).expect(204);
    const day = (siteId: string, teamId: string | null, date: string) => ({ workerId, siteId, teamId, date, status: 'WORKED', hours: '4' });

    expect((await agent.get('/api/timesheet/settings').expect(200)).body).toEqual({ entryRoles: ['TIMEKEEPER'], setBy: null, setAt: null });
    await timekeeper.agent.put(entryUrl(randomUUID())).send(day(siteA, teamA, '2026-09-02')).expect(200);
    await timekeeper.agent.put(entryUrl(randomUUID())).send(day(siteB, null, '2026-09-02')).expect(403);
    await foreman.agent.put(entryUrl(randomUUID())).send(day(siteA, teamA, '2026-09-03')).expect(403);
    await accountant.agent.put(entryUrl(randomUUID())).send(day(siteA, teamA, '2026-09-03')).expect(403);
    await pm.agent.put(entryUrl(randomUUID())).send(day(siteA, teamA, '2026-09-03')).expect(403);
    // Everyone sees the grid of the sites they see.
    expect((await accountant.agent.get(`/api/timesheet/2026/9?siteId=${siteA}`).expect(200)).body.rows[0].canEnter).toBe(false);
    expect((await pm.agent.get(`/api/timesheet/2026/9?siteId=${siteA}`).expect(200)).body.rows[0].canEnter).toBe(false);
    expect((await timekeeper.agent.get(`/api/timesheet/2026/9?siteId=${siteA}`).expect(200)).body.rows[0].canEnter).toBe(true);
    expect((await timekeeper.agent.get(`/api/timesheet/2026/9?siteId=${siteB}`).expect(404)).body.code).toBe('site.notFound');
    expect((await pm.agent.get(`/api/timesheet/2026/9?siteId=${siteB}`).expect(404)).body.code).toBe('site.notFound');

    await timekeeper.agent.put('/api/timesheet/settings').send({ entryRoles: ['FOREMAN'] }).expect(403);
    expect((await agent.put('/api/timesheet/settings').send({ entryRoles: [] }).expect(400)).body.issues).toEqual([
      { path: 'entryRoles', message: 'validation.entryRolesRequired' },
    ]);
    await agent.put('/api/timesheet/settings').send({ entryRoles: ['FOREMAN', 'TIMEKEEPER', 'FOREMAN'] }).expect(204);
    expect((await agent.get('/api/timesheet/settings').expect(200)).body.entryRoles).toEqual(['TIMEKEEPER', 'FOREMAN']);

    const own = randomUUID();
    await foreman.agent.put(entryUrl(own)).send(day(siteA, teamA, '2026-09-03')).expect(200);
    await foreman.agent.put(entryUrl(randomUUID())).send(day(siteA, teamB, '2026-09-04')).expect(403);
    await foreman.agent.put(entryUrl(randomUUID())).send(day(siteA, null, '2026-09-04')).expect(403);
    const foremanGrid = (await foreman.agent.get(`/api/timesheet/2026/9?siteId=${siteA}`).expect(200)).body;
    expect(foremanGrid.rows.map((r: { teamId: string }) => r.teamId)).toEqual([teamA]);

    // Only timekeepers again: the foreman can no longer change or remove what they entered.
    await agent.put('/api/timesheet/settings').send({ entryRoles: ['TIMEKEEPER'] }).expect(204);
    await foreman.agent.put(entryUrl(own)).send({ ...day(siteA, teamA, '2026-09-03'), hours: '5', version: 1 }).expect(403);
    await foreman.agent.delete(`${entryUrl(own)}?version=1`).expect(403);

    const log = await ctx.prisma.auditLog.findMany({ where: { action: 'timesheetSettings.set' }, orderBy: { createdAt: 'asc' } });
    expect(log.map((l) => l.data)).toEqual([
      { entryRoles: { from: ['TIMEKEEPER'], to: ['TIMEKEEPER', 'FOREMAN'] } },
      { entryRoles: { from: ['TIMEKEEPER', 'FOREMAN'], to: ['TIMEKEEPER'] } },
    ]);
  });

  it('is part of the Timesheet module', async () => {
    const { agent, siteA, teamA, workerId } = await company({ timesheetModule: false });
    expect((await agent.get(`/api/timesheet/2026/9?siteId=${siteA}`).expect(403)).body.code).toBe('module.disabled');
    expect((await agent.get('/api/timesheet/settings').expect(403)).body.code).toBe('module.disabled');
    const body = { workerId, siteId: siteA, teamId: teamA, date: '2026-09-02', status: 'WORKED', hours: '9' };
    expect((await agent.put(entryUrl(randomUUID())).send(body).expect(403)).body.code).toBe('module.disabled');
  });
});

describe('tenant isolation', () => {
  it("keeps one company out of another company's timesheet", async () => {
    const a = await company();
    const b = await company();
    const id = randomUUID();
    const cell = { workerId: a.workerId, siteId: a.siteA, teamId: a.teamA, date: '2026-09-02', status: 'WORKED', hours: '9' };
    await a.agent.put(entryUrl(id)).send(cell).expect(200);

    expect((await b.agent.get(`/api/timesheet/2026/9?siteId=${a.siteA}`).expect(404)).body.code).toBe('site.notFound');
    // A's site, team or worker in B's request.
    expect((await b.agent.put(entryUrl(randomUUID())).send(cell).expect(404)).body.code).toBe('site.notFound');
    const own = { workerId: b.workerId, siteId: b.siteA, teamId: b.teamA, date: '2026-09-02', status: 'WORKED', hours: '9' };
    expect((await b.agent.put(entryUrl(randomUUID())).send({ ...own, workerId: a.workerId }).expect(404)).body.code).toBe('worker.notFound');
    expect((await b.agent.put(entryUrl(randomUUID())).send({ ...own, teamId: a.teamA }).expect(404)).body.code).toBe('team.notFound');
    // A's entry id.
    expect((await b.agent.put(entryUrl(id)).send({ ...own, version: 1 }).expect(404)).body.code).toBe('timesheet.entryNotFound');
    await b.agent.delete(`${entryUrl(id)}?version=1`).expect(204);
    expect(await ctx.prisma.timesheetEntry.count({ where: { id } })).toBe(1);
    await b.agent.put('/api/timesheet/settings').send({ entryRoles: ['FOREMAN'] }).expect(204);
    expect((await a.agent.get('/api/timesheet/settings').expect(200)).body.entryRoles).toEqual(['TIMEKEEPER']);
  });
});

describe('payroll from daily entries', () => {
  it('pays a day split between two teams of one site, each team its own place', async () => {
    const { agent, siteA, teamA, teamB, workerId } = await company();
    await agent.put(entryUrl(randomUUID())).send({ workerId, siteId: siteA, teamId: teamA, date: '2026-09-02', status: 'WORKED', hours: '6' }).expect(200);
    await agent.put(entryUrl(randomUUID())).send({ workerId, siteId: siteA, teamId: teamB, date: '2026-09-02', status: 'WORKED', hours: '5' }).expect(200);

    const payroll = (await agent.get('/api/payroll/2026/9').expect(200)).body;
    const w = payroll.workers.find((x: { worker: { id: string } }) => x.worker.id === workerId);
    expect(w).toMatchObject({ source: 'DAILY', problems: [] });
    expect(w.parts[0].places).toEqual({
      [`${siteA}/${teamA}`]: { siteName: 'Site A', teamName: 'Team A', from: null, until: null },
      [`${siteA}/${teamB}`]: { siteName: 'Site A', teamName: 'Team B', from: null, until: null },
    });
    // 9 normal hours across the day; the team entered later gets the 2 hours above them.
    const summary = w.parts[0].result.summary;
    expect(summary).toMatchObject({ normalHours: '9.00', overtimeHours: '2.00', splitDays: 1 });
  });
});
