import type { Role } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, createUser, loginAs, memberOfNewCompany, resetDb, startApp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

// September 2026: Sept 1 is Independence Day and Sundays are rest days, so 25 working
// days: 11 on Sept 1–14 and 14 on Sept 15–30. A salary of 7 500 000 at 9 hours a day.
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
  travelPayMode: 'PER_DAY_WORKED',
  payRoundingStep: '1000',
};

type Agent = Awaited<ReturnType<typeof memberOfNewCompany>>['agent'];

/** A company with pay rules from September 2026, a site, two routes and a worker on the site with a salary. */
async function company(rules = RULES) {
  const owner = await memberOfNewCompany(ctx, 'OWNER');
  await owner.agent.put('/api/pay-rules/2026/9').send(rules).expect(204);
  const siteA = (await owner.agent.post('/api/sites').send({ name: 'Site A' }).expect(201)).body.id as string;
  const near = (await owner.agent.post('/api/travel-routes').send({ name: 'Near', amountPerDay: '20000' }).expect(201)).body.id as string;
  const far = (await owner.agent.post('/api/travel-routes').send({ name: 'Far', amountPerDay: '30000' }).expect(201)).body.id as string;
  const workerId = await hire(owner.agent, siteA, null);
  await owner.agent.post(`/api/workers/${workerId}/salaries`).send({ fromYear: 2026, fromMonth: 9, monthlySalary: '7500000' }).expect(201);
  const placementA = (await owner.agent.get(`/api/workers/${workerId}`).expect(200)).body.placement.id as string;
  return { ...owner, siteA, near, far, workerId, placementA };
}

async function hire(agent: Agent, siteId: string, travelRouteId: string | null) {
  const res = await agent
    .post('/api/workers')
    .send({ worker: { lastName: 'Testov', firstName: 'Test' }, placement: { siteId, travelRouteId, from: '2026-09-01' } })
    .expect(201);
  return res.body.id as string;
}

async function member(companyId: string, role: Role, siteId?: string, owner?: Agent) {
  const user = await createUser(ctx.prisma);
  await addMember(ctx.prisma, user.id, companyId, role);
  if (siteId && owner) await owner.post(`/api/sites/${siteId}/staff`).send({ userId: user.id }).expect(204);
  return { user, agent: await loginAs(ctx.app, user.email!) };
}

/** September's working days from `from` to `until` worked at 9 hours, written directly: these tests are about pay. */
async function work(companyId: string, assignmentId: string, siteId: string, from: string, until: string) {
  const user = await createUser(ctx.prisma);
  const period =
    (await ctx.prisma.payrollPeriod.findUnique({ where: { companyId_year_month: { companyId, year: 2026, month: 9 } } })) ??
    (await ctx.prisma.payrollPeriod.create({ data: { companyId, year: 2026, month: 9 } }));
  const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`).filter(
    (d) => d >= from && d <= until && d !== '2026-09-01' && new Date(`${d}T00:00:00Z`).getUTCDay() !== 0,
  );
  await ctx.prisma.timesheetEntry.createMany({
    data: days.map((d) => ({
      companyId,
      periodId: period.id,
      assignmentId,
      siteId,
      date: new Date(`${d}T00:00:00Z`),
      status: 'WORKED' as const,
      hours: 9,
      createdById: user.id,
      updatedById: user.id,
    })),
  });
}

async function lockSeptember(companyId: string, userId: string) {
  await ctx.prisma.payrollPeriod.upsert({
    where: { companyId_year_month: { companyId, year: 2026, month: 9 } },
    create: { companyId, year: 2026, month: 9, status: 'LOCKED', lockedAt: new Date(), lockedById: userId },
    update: { status: 'LOCKED', lockedAt: new Date(), lockedById: userId },
  });
}

const travelLines = (worker: { parts: { result: { lines: { type: string }[] } }[] }) =>
  worker.parts.flatMap((p) => p.result.lines.filter((l) => l.type.startsWith('TRAVEL')));

describe('travel routes', () => {
  it('lets owners and admins define routes, fixing the amount once a placement has had one', async () => {
    const { company: c, agent, siteA, near, workerId, placementA } = await company();
    const accountant = await member(c.id, 'ACCOUNTANT');
    const timekeeper = await member(c.id, 'TIMEKEEPER');
    await accountant.agent.post('/api/travel-routes').send({ name: 'Other', amountPerDay: '1000' }).expect(403);
    await timekeeper.agent.get('/api/travel-routes').expect(403);
    expect((await agent.post('/api/travel-routes').send({ name: 'near', amountPerDay: '1' }).expect(409)).body.code).toBe(
      'travelRoute.nameTaken',
    );
    const invalid = await agent.post('/api/travel-routes').send({ name: 'Zero', amountPerDay: '0' }).expect(400);
    expect(invalid.body.issues).toEqual([{ path: 'amountPerDay', message: 'validation.routeAmountRange' }]);

    // Nobody has it yet, so its amount can change.
    await agent.patch(`/api/travel-routes/${near}`).send({ amountPerDay: '25000' }).expect(204);
    await agent.put(`/api/workers/${workerId}/placements/${placementA}/travel-route`).send({ travelRouteId: near }).expect(204);
    expect((await agent.patch(`/api/travel-routes/${near}`).send({ amountPerDay: '20000' }).expect(409)).body.code).toBe(
      'travelRoute.inUse',
    );
    await agent.patch(`/api/travel-routes/${near}`).send({ name: 'Near village', isActive: false }).expect(204);

    expect((await accountant.agent.get('/api/travel-routes').expect(200)).body).toEqual([
      expect.objectContaining({ name: 'Far', amountPerDay: '30000', isActive: true, inUse: false }),
      { id: near, name: 'Near village', amountPerDay: '25000', isActive: false, inUse: true },
    ]);
    const log = await ctx.prisma.auditLog.findMany({ where: { action: 'travelRoute.update' }, orderBy: { createdAt: 'asc' } });
    expect(log.map((l) => l.data)).toEqual([
      { changes: { amountPerDay: { from: '20000', to: '25000' } } },
      { changes: { name: { from: 'Near', to: 'Near village' }, isActive: { from: true, to: false } } },
    ]);
    // An archived route isn't given any more, but the placement that has it keeps it.
    const other = await hire(agent, siteA, null);
    const otherPlacement = (await agent.get(`/api/workers/${other}`).expect(200)).body.placement.id as string;
    const archived = await agent.put(`/api/workers/${other}/placements/${otherPlacement}/travel-route`).send({ travelRouteId: near }).expect(409);
    expect(archived.body.code).toBe('travelRoute.inactive');
  });

  it('gives placements a route when placed or later, refusing locked months, shown without its amount', async () => {
    const { company: c, user, agent, siteA, near, far, workerId, placementA } = await company();
    const url = `/api/workers/${workerId}/placements/${placementA}/travel-route`;
    await agent.put(url).send({ travelRouteId: near }).expect(204);
    expect((await agent.put(url).send({ travelRouteId: near }).expect(409)).body.code).toBe('placement.routeUnchanged');

    const timekeeper = await member(c.id, 'TIMEKEEPER', siteA, agent);
    const seen = (await timekeeper.agent.get(`/api/workers/${workerId}`).expect(200)).body;
    expect(seen.placement).toMatchObject({ travelRouteId: near, travelRouteName: 'Near' });
    expect(JSON.stringify(seen)).not.toContain('20000');
    await timekeeper.agent.put(url).send({ travelRouteId: far }).expect(403);

    await lockSeptember(c.id, user.id);
    expect((await agent.put(url).send({ travelRouteId: far }).expect(409)).body.code).toBe('period.locked');
    // A move from a day in an open month (the current placement ending in one too) gives the new route instead.
    await agent.post(`/api/workers/${workerId}/placements`).send({ siteId: siteA, travelRouteId: far, from: '2026-10-02' }).expect(204);
    expect((await agent.get(`/api/workers/${workerId}`).expect(200)).body.placement).toMatchObject({ travelRouteName: 'Far', from: '2026-10-02' });

    const log = await ctx.prisma.auditLog.findMany({ where: { action: 'worker.placementTravelRoute' } });
    expect(log.map((l) => l.data)).toEqual([
      { assignmentId: placementA, from: null, to: { id: near, name: 'Near', amountPerDay: '20000' } },
    ]);
  });

  it("keeps each company's routes to itself", async () => {
    const a = await company();
    const b = await company();
    expect((await b.agent.get('/api/travel-routes').expect(200)).body.map((r: { id: string }) => r.id)).not.toContain(a.near);
    await b.agent.patch(`/api/travel-routes/${a.near}`).send({ name: 'Mine' }).expect(404);
    const res = await b.agent.put(`/api/workers/${b.workerId}/placements/${b.placementA}/travel-route`).send({ travelRouteId: a.near }).expect(404);
    expect(res.body.code).toBe('travelRoute.notFound');
    await b.agent
      .post('/api/workers')
      .send({ worker: { lastName: 'X', firstName: 'Y' }, placement: { siteId: b.siteA, travelRouteId: a.near, from: '2026-09-01' } })
      .expect(404);
    await b.agent.put(`/api/workers/${a.workerId}/placements/${a.placementA}/travel-route`).send({ travelRouteId: b.near }).expect(404);
  });
});

describe('travel pay per day worked', () => {
  it("pays each placement's own route, also for two placements at one site in a month", async () => {
    const { company: c, agent, siteA, near, far, workerId, placementA } = await company();
    await agent.put(`/api/workers/${workerId}/placements/${placementA}/travel-route`).send({ travelRouteId: near }).expect(204);
    await agent.post(`/api/workers/${workerId}/placements`).send({ siteId: siteA, travelRouteId: far, from: '2026-09-15' }).expect(204);
    const placementB = (await agent.get(`/api/workers/${workerId}`).expect(200)).body.placement.id as string;
    await work(c.id, placementA, siteA, '2026-09-01', '2026-09-14');
    await work(c.id, placementB, siteA, '2026-09-15', '2026-09-30');

    const [worker] = (await agent.get('/api/payroll/2026/9').expect(200)).body.workers;
    expect(worker.problems).toEqual([]);
    // Each placement's hours are a place of their own (in the order of their keys), with its own route.
    expect(travelLines(worker)).toHaveLength(2);
    expect(travelLines(worker)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ place: `${placementA}/${siteA}`, route: 'Near', days: 11, amountPerDay: '20000.00', amount: '220000.00' }),
        expect.objectContaining({ place: `${placementB}/${siteA}`, route: 'Far', days: 14, amountPerDay: '30000.00', amount: '420000.00' }),
      ]),
    );
    expect(worker.total).toBe('8140000.00');
  });
});

describe('monthly travel amounts', () => {
  const MONTHLY = { ...RULES, travelPayMode: 'MONTHLY_AMOUNT' };

  it('lets owners, admins and accountants add amounts per placement-month, newest counting', async () => {
    const { company: c, agent, siteA, placementA } = await company(MONTHLY);
    const accountant = await member(c.id, 'ACCOUNTANT');
    const pm = await member(c.id, 'PROJECT_MANAGER');
    const url = `/api/travel-amounts/2026/9/${placementA}`;
    await pm.agent.post(url).send({ amount: '400000' }).expect(403);
    await pm.agent.get('/api/travel-amounts/2026/9').expect(403);

    await accountant.agent.post(url).send({ amount: '400000' }).expect(201);
    expect((await accountant.agent.post(url).send({ amount: '400000', note: 'x' }).expect(409)).body.code).toBe('travelAmount.unchanged');
    await accountant.agent.post(url).send({ amount: '500000', note: 'Bus fare rose' }).expect(201);
    expect((await accountant.agent.post('/api/travel-amounts/2026/8/' + placementA).send({ amount: '1' }).expect(409)).body.code).toBe(
      'travelAmount.notInMonth',
    );

    const month = (await accountant.agent.get('/api/travel-amounts/2026/9').expect(200)).body;
    expect(month).toMatchObject({ year: 2026, month: 9, locked: false });
    expect(month.rows).toHaveLength(1);
    expect(month.rows[0]).toMatchObject({ assignmentId: placementA, siteName: 'Site A', travelPayMode: 'MONTHLY_AMOUNT' });
    expect(month.rows[0].history.map((h: { amount: string; corrected: boolean; note: string | null }) => [h.amount, h.corrected, h.note])).toEqual([
      ['500000', false, 'Bus fare rose'],
      ['400000', true, null],
    ]);
    const log = await ctx.prisma.auditLog.findMany({ where: { action: 'travelAmount.add' }, orderBy: { createdAt: 'asc' } });
    expect(log.map((l) => [(l.data as { from: unknown }).from, (l.data as { to: unknown }).to])).toEqual([
      [null, '400000'],
      ['400000', '500000'],
    ]);

    await work(c.id, placementA, siteA, '2026-09-01', '2026-09-30');
    const [worker] = (await agent.get('/api/payroll/2026/9').expect(200)).body.workers;
    expect(travelLines(worker)).toEqual([{ type: 'TRAVEL_MONTHLY', amount: '500000.00' }]);
    expect(worker.total).toBe('8000000.00');
  });

  it('pays the amount once when a shift change splits the month', async () => {
    const { company: c, agent, siteA, workerId, placementA } = await company(MONTHLY);
    const night = (await agent.post('/api/shifts').send({ name: 'Night', normalHoursPerDay: '10' }).expect(201)).body.id as string;
    await agent.post('/api/worker-shifts').send({ workerIds: [workerId], shiftId: night, from: '2026-09-15' }).expect(201);
    // The night shift's normal 10 hours from the change on.
    await work(c.id, placementA, siteA, '2026-09-01', '2026-09-30');
    await ctx.prisma.timesheetEntry.updateMany({ where: { date: { gte: new Date('2026-09-15T00:00:00Z') } }, data: { hours: 10 } });
    await agent.post(`/api/travel-amounts/2026/9/${placementA}`).send({ amount: '500000' }).expect(201);

    const [worker] = (await agent.get('/api/payroll/2026/9').expect(200)).body.workers;
    expect(worker.problems).toEqual([]);
    expect(worker.parts).toHaveLength(2);
    expect(travelLines(worker)).toEqual([{ type: 'TRAVEL_MONTHLY', amount: '500000.00' }]);
    // 7 500 000 for the full month on its shifts, plus the travel amount once.
    expect(worker.total).toBe('8000000.00');
  });

  it('refuses amounts in a locked month', async () => {
    const { company: c, user, agent, placementA } = await company(MONTHLY);
    await lockSeptember(c.id, user.id);
    expect((await agent.post(`/api/travel-amounts/2026/9/${placementA}`).send({ amount: '1' }).expect(409)).body.code).toBe('period.locked');
    expect((await agent.get('/api/travel-amounts/2026/9').expect(200)).body.locked).toBe(true);
  });

  it("keeps each company's amounts to itself", async () => {
    const a = await company(MONTHLY);
    const b = await company(MONTHLY);
    await a.agent.post(`/api/travel-amounts/2026/9/${a.placementA}`).send({ amount: '500000' }).expect(201);
    expect((await b.agent.post(`/api/travel-amounts/2026/9/${a.placementA}`).send({ amount: '1' }).expect(404)).body.code).toBe(
      'placement.notFound',
    );
    const rows = (await b.agent.get('/api/travel-amounts/2026/9').expect(200)).body.rows;
    expect(rows.map((r: { assignmentId: string }) => r.assignmentId)).toEqual([b.placementA]);
    expect(rows[0].history).toEqual([]);
  });
});
