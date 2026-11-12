import type { Role } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, createUser, loginAs, memberOfNewCompany, paidCategories, resetDb, setUpPay, startApp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

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

/** A company with pay rules from September 2026, a site and the positions "Plumber" and "Electrician". */
async function company() {
  const owner = await memberOfNewCompany(ctx, 'OWNER');
  await setUpPay(owner.agent, RULES);
  const site = (await owner.agent.post('/api/sites').send({ name: 'Site A' }).expect(201)).body.id as string;
  const plumber = await position(owner.agent, 'Plumber');
  const electrician = await position(owner.agent, 'Electrician');
  return { ...owner, site, plumber, electrician };
}

async function position(agent: Agent, name: string) {
  return (await agent.post('/api/positions').send({ name }).expect(201)).body.id as string;
}

/** Hires a worker on the site from Sept 1, with a position or without. */
async function hire(agent: Agent, siteId: string, lastName: string, positionId: string | null = null) {
  const categories = await paidCategories(agent);
  const res = await agent
    .post('/api/workers')
    .send({ worker: { lastName, firstName: 'Test', categories }, placement: { siteId, from: '2026-09-01' }, positionId })
    .expect(201);
  return res.body.id as string;
}

async function member(companyId: string, role: Role, siteId?: string, owner?: Agent) {
  const user = await createUser(ctx.prisma);
  await addMember(ctx.prisma, user.id, companyId, role);
  if (siteId && owner) await owner.post(`/api/sites/${siteId}/staff`).send({ userId: user.id }).expect(204);
  return { user, agent: await loginAs(ctx.app, user.email!) };
}

const rowsOf = async (agent: Agent, workerId: string) =>
  ((await agent.get(`/api/workers/${workerId}/positions`).expect(200)).body as { id: string; from: string; position: { name: string } | null }[]).map(
    (r) => [r.from, r.position?.name ?? null],
  );

/** Twelve September days worked 8 hours, written directly, so the month can be paid. */
async function workSomeDays(companyId: string, workerId: string, siteId: string) {
  const user = await createUser(ctx.prisma);
  const period = await ctx.prisma.payrollPeriod.upsert({
    where: { companyId_year_month: { companyId, year: 2026, month: 9 } },
    create: { companyId, year: 2026, month: 9 },
    update: {},
  });
  const placement = await ctx.prisma.assignment.findFirstOrThrow({ where: { workerId } });
  await ctx.prisma.timesheetEntry.createMany({
    data: ['02', '03', '04', '05'].map((d) => ({
      companyId,
      periodId: period.id,
      assignmentId: placement.id,
      siteId,
      date: new Date(`2026-09-${d}T00:00:00Z`),
      status: 'WORKED' as const,
      hours: 8,
      createdById: user.id,
      updatedById: user.id,
    })),
  });
}

describe('positions', () => {
  it('lets owners and admins keep the list, and everyone see it', async () => {
    const { company: c, agent, site, plumber } = await company();
    expect((await agent.post('/api/positions').send({ name: ' plumber ' }).expect(409)).body.code).toBe('position.nameTaken');
    await agent.patch(`/api/positions/${plumber}`).send({ name: 'Pipe fitter' }).expect(204);
    await agent.patch(`/api/positions/${plumber}`).send({ isActive: false }).expect(204);

    const timekeeper = await member(c.id, 'TIMEKEEPER', site, agent);
    const list = (await timekeeper.agent.get('/api/positions').expect(200)).body;
    expect(list.map((p: { name: string; isActive: boolean; uses: number }) => [p.name, p.isActive, p.uses])).toEqual([
      ['Electrician', true, 0],
      ['Pipe fitter', false, 0],
    ]);
    for (const role of ['ACCOUNTANT', 'PROJECT_MANAGER', 'TIMEKEEPER', 'FOREMAN'] as const) {
      const other = await member(c.id, role);
      await other.agent.post('/api/positions').send({ name: 'Welder' }).expect(403);
      await other.agent.patch(`/api/positions/${plumber}`).send({ name: 'Welder' }).expect(403);
    }
    const log = await ctx.prisma.auditLog.findMany({ where: { action: 'position.update' }, orderBy: { createdAt: 'asc' } });
    expect(log.map((l) => l.data)).toEqual([
      { changes: { name: { from: 'Plumber', to: 'Pipe fitter' } } },
      { changes: { isActive: { from: true, to: false } } },
    ]);
  });

  it("starts a new worker's position from their first day, and a new one from a day", async () => {
    const { company: c, agent, site, plumber, electrician } = await company();
    const worker = await hire(agent, site, 'Maxov', plumber);
    expect(await rowsOf(agent, worker)).toEqual([['2026-09-01', 'Plumber']]);

    // Whoever may edit the worker gives a new position from a day: a project manager of the site.
    const pm = await member(c.id, 'PROJECT_MANAGER', site, agent);
    await pm.agent.post(`/api/workers/${worker}/positions`).send({ positionId: electrician, from: '2026-09-16' }).expect(201);
    expect(await rowsOf(agent, worker)).toEqual([
      ['2026-09-01', 'Plumber'],
      ['2026-09-16', 'Electrician'],
    ]);
    const taken = await pm.agent.post(`/api/workers/${worker}/positions`).send({ positionId: plumber, from: '2026-09-16' }).expect(409);
    expect(taken.body.code).toBe('workerPosition.dayTaken');
    const same = await pm.agent.post(`/api/workers/${worker}/positions`).send({ positionId: electrician, from: '2026-09-20' }).expect(409);
    expect(same.body.code).toBe('workerPosition.unchanged');
    // No position from a day.
    await pm.agent.post(`/api/workers/${worker}/positions`).send({ positionId: null, from: '2026-10-01' }).expect(201);

    // Accountants, timekeepers and foremen see positions but give none; a project manager of another site neither.
    const timekeeper = await member(c.id, 'TIMEKEEPER', site, agent);
    expect(await rowsOf(timekeeper.agent, worker)).toHaveLength(3);
    for (const role of ['ACCOUNTANT', 'TIMEKEEPER'] as const) {
      const other = await member(c.id, role, role === 'TIMEKEEPER' ? site : undefined, agent);
      await other.agent.post(`/api/workers/${worker}/positions`).send({ positionId: plumber, from: '2026-11-01' }).expect(403);
    }
    const elsewhere = (await agent.post('/api/sites').send({ name: 'Site B' }).expect(201)).body.id as string;
    const otherPm = await member(c.id, 'PROJECT_MANAGER', elsewhere, agent);
    await otherPm.agent.post(`/api/workers/${worker}/positions`).send({ positionId: plumber, from: '2026-11-01' }).expect(404);

    const log = await ctx.prisma.auditLog.findMany({ where: { action: 'workerPosition.add' }, orderBy: { createdAt: 'asc' } });
    expect(log.map((l) => l.data)).toEqual([
      expect.objectContaining({ from: '2026-09-16', position: { id: electrician, name: 'Electrician' }, before: plumber }),
      expect.objectContaining({ from: '2026-10-01', position: null, before: electrician }),
    ]);
  });

  it('shows the position today in the workers list, also to timekeepers', async () => {
    const { company: c, agent, site, plumber, electrician } = await company();
    const worker = await hire(agent, site, 'Maxov', plumber);
    await agent.post(`/api/workers/${worker}/positions`).send({ positionId: electrician, from: '2031-01-01' }).expect(201);
    const timekeeper = await member(c.id, 'TIMEKEEPER', site, agent);
    const [row] = (await timekeeper.agent.get('/api/workers').expect(200)).body;
    expect(row.position).toEqual({ id: plumber, name: 'Plumber' });
    expect(row.salary).toBeNull();
  });

  it('lets only owners and admins correct or remove a row, audited with old and new values', async () => {
    const { company: c, agent, site, plumber, electrician } = await company();
    const worker = await hire(agent, site, 'Maxov', plumber);
    const row = (await agent.post(`/api/workers/${worker}/positions`).send({ positionId: electrician, from: '2026-09-16' }).expect(201)).body.id;
    const pm = await member(c.id, 'PROJECT_MANAGER', site, agent);
    await pm.agent.put(`/api/workers/${worker}/positions/${row}`).send({ positionId: electrician, from: '2026-09-20' }).expect(403);
    await pm.agent.delete(`/api/workers/${worker}/positions/${row}`).expect(403);

    await agent.put(`/api/workers/${worker}/positions/${row}`).send({ positionId: electrician, from: '2026-09-20' }).expect(204);
    expect(await rowsOf(agent, worker)).toEqual([
      ['2026-09-01', 'Plumber'],
      ['2026-09-20', 'Electrician'],
    ]);
    await agent.delete(`/api/workers/${worker}/positions/${row}`).expect(204);
    expect(await rowsOf(agent, worker)).toEqual([['2026-09-01', 'Plumber']]);

    const log = await ctx.prisma.auditLog.findMany({ where: { action: { in: ['workerPosition.correct', 'workerPosition.remove'] } }, orderBy: { createdAt: 'asc' } });
    expect(log.map((l) => l.data)).toEqual([
      {
        workerPositionId: row,
        from: { from: '2026-09-16', positionId: electrician, name: 'Electrician' },
        to: { from: '2026-09-20', positionId: electrician, name: 'Electrician' },
      },
      { workerPositionId: row, from: { from: '2026-09-20', positionId: electrician, name: 'Electrician' } },
    ]);
  });

  it("gives no position that is closed, and merges one into another with its workers' history", async () => {
    const { agent, site, plumber, electrician } = await company();
    const worker = await hire(agent, site, 'Maxov', plumber);
    const other = await position(agent, 'Plumer');
    await agent.post(`/api/workers/${worker}/positions`).send({ positionId: other, from: '2026-09-16' }).expect(201);
    await agent.patch(`/api/positions/${electrician}`).send({ isActive: false }).expect(204);
    const closed = await agent.post(`/api/workers/${worker}/positions`).send({ positionId: electrician, from: '2026-10-01' }).expect(409);
    expect(closed.body.code).toBe('position.inactive');

    expect((await agent.post(`/api/positions/${other}/merge`).send({ intoId: other }).expect(409)).body.code).toBe('position.mergeIntoItself');
    expect((await agent.post(`/api/positions/${other}/merge`).send({ intoId: plumber }).expect(201)).body).toEqual({ moved: 1 });
    expect((await agent.get('/api/positions').expect(200)).body.map((p: { name: string; uses: number }) => [p.name, p.uses])).toEqual([
      ['Electrician', 0],
      ['Plumber', 2],
    ]);
    // The second row changes nothing any more: both are the plumber.
    expect(await rowsOf(agent, worker)).toEqual([
      ['2026-09-01', 'Plumber'],
      ['2026-09-16', 'Plumber'],
    ]);
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'position.merge' } });
    expect(log.data).toEqual({ from: { id: other, name: 'Plumer' }, into: { id: plumber, name: 'Plumber' }, moved: 1 });
  });

  it("lists the month's positions on the pay result without splitting pay, and totals by the position at the month's end", async () => {
    const { company: c, agent, site, plumber, electrician } = await company();
    const max = await hire(agent, site, 'Maxov', plumber);
    const other = await hire(agent, site, 'Otherov', plumber);
    const none = await hire(agent, site, 'Noneov');
    await agent.post(`/api/workers/${max}/positions`).send({ positionId: electrician, from: '2026-09-16' }).expect(201);
    for (const id of [max, other, none]) {
      await agent.post(`/api/workers/${id}/salaries`).send({ from: '2026-09-01', monthlySalary: '5000000' }).expect(201);
      await workSomeDays(c.id, id, site);
    }

    const month = (await agent.get('/api/payroll/2026/9').expect(200)).body;
    const w = month.workers.find((x: { worker: { id: string } }) => x.worker.id === max);
    expect(w.positions).toEqual([
      { from: '2026-09-01', until: '2026-09-15', name: 'Plumber' },
      { from: '2026-09-16', until: '2026-09-30', name: 'Electrician' },
    ]);
    expect(w.position).toEqual({ id: electrician, name: 'Electrician' });
    expect(w.worker.position).toBe('Electrician');
    // One part: a position change never splits pay. 4 days × 8 h × 25 000.
    expect(w.parts).toHaveLength(1);
    expect(w.total).toBe('800000.00');
    expect(month.positions).toEqual([
      { position: { id: electrician, name: 'Electrician' }, workers: 1, withProblems: 0, total: '800000.00' },
      { position: { id: plumber, name: 'Plumber' }, workers: 1, withProblems: 0, total: '800000.00' },
      { position: null, workers: 1, withProblems: 0, total: '800000.00' },
    ]);
  });

  it('never changes a locked month, which keeps the positions it was locked with', async () => {
    const { company: c, agent, site, plumber, electrician } = await company();
    const worker = await hire(agent, site, 'Maxov', plumber);
    const later = (await agent.post(`/api/workers/${worker}/positions`).send({ positionId: electrician, from: '2026-10-10' }).expect(201)).body.id;
    await ctx.prisma.payrollPeriod.create({
      data: { companyId: c.id, year: 2026, month: 9, status: 'LOCKED', lockedAt: new Date(), lockedById: (await createUser(ctx.prisma)).id },
    });

    const add = await agent.post(`/api/workers/${worker}/positions`).send({ positionId: electrician, from: '2026-09-16' }).expect(409);
    expect(add.body.code).toBe('period.locked');
    const move = await agent.put(`/api/workers/${worker}/positions/${later}`).send({ positionId: electrician, from: '2026-09-20' }).expect(409);
    expect(move.body.code).toBe('period.locked');
    // October is open.
    await agent.put(`/api/workers/${worker}/positions/${later}`).send({ positionId: electrician, from: '2026-10-05' }).expect(204);
  });

  it("never shows, gives or changes another company's positions", async () => {
    const a = await company();
    const b = await company();
    const worker = await hire(a.agent, a.site, 'Maxov', a.plumber);
    const row = (await ctx.prisma.workerPosition.findFirstOrThrow({ where: { workerId: worker } })).id;
    const own = await hire(b.agent, b.site, 'Otherov');

    expect((await b.agent.get('/api/positions').expect(200)).body.map((p: { id: string }) => p.id).sort()).toEqual([b.plumber, b.electrician].sort());
    await b.agent.patch(`/api/positions/${a.plumber}`).send({ name: 'Taken' }).expect(404);
    await b.agent.post(`/api/positions/${a.plumber}/merge`).send({ intoId: b.plumber }).expect(404);
    await b.agent.post(`/api/positions/${b.plumber}/merge`).send({ intoId: a.plumber }).expect(404);
    await b.agent.get(`/api/workers/${worker}/positions`).expect(404);
    await b.agent.post(`/api/workers/${worker}/positions`).send({ positionId: b.plumber, from: '2026-09-16' }).expect(404);
    await b.agent.put(`/api/workers/${worker}/positions/${row}`).send({ positionId: b.plumber, from: '2026-09-02' }).expect(404);
    await b.agent.delete(`/api/workers/${worker}/positions/${row}`).expect(404);
    // Another company's position can't be given to an own worker, at hiring either.
    await b.agent.post(`/api/workers/${own}/positions`).send({ positionId: a.plumber, from: '2026-09-16' }).expect(404);
    const categories = await paidCategories(b.agent);
    await b.agent
      .post('/api/workers')
      .send({ worker: { lastName: 'X', firstName: 'Y', categories }, placement: { siteId: b.site, from: '2026-09-01' }, positionId: a.plumber })
      .expect(404);
    expect(await ctx.prisma.workerPosition.count()).toBe(1);
    expect((await ctx.prisma.position.findUniqueOrThrow({ where: { id: a.plumber } })).name).toBe('Plumber');
  });
});
