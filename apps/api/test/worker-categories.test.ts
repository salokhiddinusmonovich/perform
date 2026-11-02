import type { Role } from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, createUser, loginAs, memberOfNewCompany, resetDb, startApp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

type Agent = Awaited<ReturnType<typeof memberOfNewCompany>>['agent'];

// September 2026: Sept 1 is a holiday and Sundays are rest days, so 25 working days.
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
  from: '2026-09-01',
  until: '2026-09-30',
  normalHours: '225',
  overtimeHours: '0',
  restDayHours: '0',
  holidayHours: '0',
  workdaysWorked: 25,
  leaveDays: 0,
  sickDays: 0,
  travelDays: 0,
};

/** A company with rules for September, a site, and two categories: Direct/Indirect and Origin. */
async function company() {
  const owner = await memberOfNewCompany(ctx, 'OWNER');
  await owner.agent.put('/api/pay-rules/2026/9').send(RULES).expect(204);
  const site = (await owner.agent.post('/api/sites').send({ name: 'Site A' }).expect(201)).body.id as string;
  const type = await category(owner.agent, 'Direkt / Endirekt', ['Direkt', 'Endirekt']);
  const origin = await category(owner.agent, 'Origin', ['Local', 'Foreign']);
  return { ...owner, site, type, origin };
}

async function category(agent: Agent, name: string, options: string[]) {
  const { id } = (await agent.post('/api/worker-categories').send({ name, options }).expect(201)).body;
  return { id: id as string, options: await optionIds(agent, id) };
}

async function optionIds(agent: Agent, id: string): Promise<Record<string, string>> {
  const all = (await agent.get('/api/worker-categories').expect(200)).body as { id: string; options: { id: string; name: string }[] }[];
  return Object.fromEntries(all.find((c) => c.id === id)!.options.map((o) => [o.name, o.id]));
}

async function member(companyId: string, role: Role) {
  const user = await createUser(ctx.prisma);
  await addMember(ctx.prisma, user.id, companyId, role);
  return { user, agent: await loginAs(ctx.app, user.email!) };
}

const worker = (lastName: string, categories: Record<string, string | null>) => ({ lastName, firstName: 'Test', categories });

const hire = (agent: Agent, siteId: string, lastName: string, categories: Record<string, string | null> = {}) =>
  agent.post('/api/workers').send({ worker: worker(lastName, categories), placement: { siteId, from: '2026-09-01' } });

/** A worker paid exactly their salary for September, from monthly totals. */
async function paidWorker(c: Awaited<ReturnType<typeof company>>, lastName: string, categories: Record<string, string | null>) {
  const id = (await hire(c.agent, c.site, lastName, categories).expect(201)).body.id as string;
  await c.agent.post(`/api/workers/${id}/salaries`).send({ fromYear: 2026, fromMonth: 9, monthlySalary: '7500000' }).expect(201);
  const placement = await ctx.prisma.assignment.findFirstOrThrow({ where: { workerId: id } });
  await c.agent.post(`/api/monthly-hours/2026/9/${placement.id}`).send(FULL_MONTH).expect(201);
  return id;
}

describe('worker categories', () => {
  it('lets owners and admins manage them and their options; everyone sees them; audited', async () => {
    const c = await company();
    const foreman = await member(c.company.id, 'FOREMAN');
    const accountant = await member(c.company.id, 'ACCOUNTANT');
    await accountant.agent.post('/api/worker-categories').send({ name: 'Grade', options: ['A', 'B'] }).expect(403);
    await accountant.agent.patch(`/api/worker-categories/${c.origin.id}`).send({ name: 'New' }).expect(403);
    await accountant.agent.post(`/api/worker-categories/${c.origin.id}/options`).send({ name: 'Other' }).expect(403);

    expect((await foreman.agent.get('/api/worker-categories').expect(200)).body).toEqual([
      {
        id: c.type.id,
        name: 'Direkt / Endirekt',
        isActive: true,
        options: [
          { id: c.type.options.Direkt, name: 'Direkt', isActive: true },
          { id: c.type.options.Endirekt, name: 'Endirekt', isActive: true },
        ],
      },
      {
        id: c.origin.id,
        name: 'Origin',
        isActive: true,
        options: [
          { id: c.origin.options.Local, name: 'Local', isActive: true },
          { id: c.origin.options.Foreign, name: 'Foreign', isActive: true },
        ],
      },
    ]);

    const taken = await c.agent.post('/api/worker-categories').send({ name: 'origin', options: ['A', 'B'] }).expect(409);
    expect(taken.body.code).toBe('workerCategory.nameTaken');
    const twice = await c.agent.post(`/api/worker-categories/${c.origin.id}/options`).send({ name: 'LOCAL' }).expect(409);
    expect(twice.body.code).toBe('workerCategory.optionTaken');
    const one = await c.agent.post('/api/worker-categories').send({ name: 'Grade', options: ['A'] }).expect(400);
    expect(one.body.issues).toEqual([{ path: 'options', message: 'validation.twoOptions' }]);

    await c.agent.patch(`/api/worker-categories/${c.origin.id}`).send({ name: 'Yerel / Yabancı' }).expect(204);
    await c.agent.patch(`/api/worker-categories/${c.origin.id}/options/${c.origin.options.Local}`).send({ name: 'Yerel' }).expect(204);
    const { id: other } = (await c.agent.post(`/api/worker-categories/${c.origin.id}/options`).send({ name: 'Diğer' }).expect(201)).body;
    // Options stay in the order they were added, whatever their names.
    expect(Object.keys(await optionIds(c.agent, c.origin.id))).toEqual(['Yerel', 'Foreign', 'Diğer']);
    const log = await ctx.prisma.auditLog.findMany({
      where: { companyId: c.company.id, action: { startsWith: 'workerCategory.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(log.map((l) => [l.action, l.data])).toEqual([
      ['workerCategory.create', { name: 'Direkt / Endirekt', options: ['Direkt', 'Endirekt'] }],
      ['workerCategory.create', { name: 'Origin', options: ['Local', 'Foreign'] }],
      ['workerCategory.update', { changes: { name: { from: 'Origin', to: 'Yerel / Yabancı' } } }],
      ['workerCategory.updateOption', { optionId: c.origin.options.Local, changes: { name: { from: 'Local', to: 'Yerel' } } }],
      ['workerCategory.addOption', { optionId: other, name: 'Diğer' }],
    ]);
  });

  it('sets a worker’s options, keeps a closed one but never gives it anew, and audits changes', async () => {
    const c = await company();
    const id = (await hire(c.agent, c.site, 'Aliyev', { [c.type.id]: c.type.options.Direkt }).expect(201)).body.id as string;
    expect((await c.agent.get(`/api/workers/${id}`).expect(200)).body.categories).toEqual({ [c.type.id]: c.type.options.Direkt });

    // Left out: kept; null: cleared.
    await c.agent.patch(`/api/workers/${id}`).send(worker('Aliyev', { [c.origin.id]: c.origin.options.Foreign })).expect(204);
    expect((await c.agent.get(`/api/workers/${id}`).expect(200)).body.categories).toEqual({
      [c.type.id]: c.type.options.Direkt,
      [c.origin.id]: c.origin.options.Foreign,
    });
    await c.agent.patch(`/api/workers/${id}`).send(worker('Aliyev', { [c.type.id]: null })).expect(204);
    expect((await c.agent.get(`/api/workers/${id}`).expect(200)).body.categories).toEqual({ [c.origin.id]: c.origin.options.Foreign });
    const log = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'worker.update', entityId: id },
      orderBy: { createdAt: 'desc' },
    });
    expect(log.data).toEqual({ changes: { categories: { [c.type.id]: { from: c.type.options.Direkt, to: null } } } });

    // Another category's option, or a closed one, isn't taken.
    const wrong = await c.agent.patch(`/api/workers/${id}`).send(worker('Aliyev', { [c.type.id]: c.origin.options.Local })).expect(400);
    expect(wrong.body.issues).toEqual([{ path: `categories.${c.type.id}`, message: 'validation.invalid' }]);
    await c.agent.patch(`/api/worker-categories/${c.origin.id}/options/${c.origin.options.Foreign}`).send({ isActive: false }).expect(204);
    const closed = await hire(c.agent, c.site, 'Karimov', { [c.origin.id]: c.origin.options.Foreign }).expect(400);
    expect(closed.body.issues).toEqual([{ path: `worker.categories.${c.origin.id}`, message: 'validation.optionClosed' }]);
    // The worker who has it keeps it through other changes.
    await c.agent.patch(`/api/workers/${id}`).send(worker('Aliyev Jr', { [c.origin.id]: c.origin.options.Foreign })).expect(204);

    await c.agent.patch(`/api/worker-categories/${c.type.id}`).send({ isActive: false }).expect(204);
    const inactive = await c.agent.patch(`/api/workers/${id}`).send(worker('Aliyev', { [c.type.id]: c.type.options.Direkt })).expect(409);
    expect(inactive.body.code).toBe('workerCategory.inactive');
  });

  it("keeps another company's categories apart", async () => {
    const a = await company();
    const b = await company();
    const inB = (await hire(b.agent, b.site, 'Aliyev', { [b.type.id]: b.type.options.Direkt }).expect(201)).body.id as string;

    expect((await a.agent.get('/api/worker-categories').expect(200)).body.map((c: { id: string }) => c.id)).not.toContain(b.type.id);
    await a.agent.patch(`/api/worker-categories/${b.type.id}`).send({ name: 'Stolen' }).expect(404);
    await a.agent.post(`/api/worker-categories/${b.type.id}/options`).send({ name: 'Stolen' }).expect(404);
    await a.agent.patch(`/api/worker-categories/${b.type.id}/options/${b.type.options.Direkt}`).send({ name: 'Stolen' }).expect(404);
    await hire(a.agent, a.site, 'Karimov', { [b.type.id]: b.type.options.Direkt }).expect(404);
    // The database refuses a worker's option from another company too.
    const inA = (await hire(a.agent, a.site, 'Karimov').expect(201)).body.id as string;
    await expect(
      ctx.prisma.workerCategoryValue.create({
        data: { companyId: a.company.id, workerId: inA, categoryId: b.type.id, optionId: b.type.options.Direkt },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect((await b.agent.get(`/api/workers/${inB}`).expect(200)).body.categories).toEqual({ [b.type.id]: b.type.options.Direkt });
  });

  it('totals pay by category and by two crossed, and a locked month keeps the options it was locked with', async () => {
    const c = await company();
    const { Direkt, Endirekt } = c.type.options;
    const { Local, Foreign } = c.origin.options;
    const aliyev = await paidWorker(c, 'Aliyev', { [c.type.id]: Direkt, [c.origin.id]: Local });
    await paidWorker(c, 'Karimov', { [c.type.id]: Direkt, [c.origin.id]: Foreign });
    await paidWorker(c, 'Sobirov', { [c.type.id]: Endirekt });
    // No salary: can't be paid, so counted but not in the hours and total.
    await hire(c.agent, c.site, 'Toshev', { [c.type.id]: Endirekt, [c.origin.id]: Local }).expect(201);

    const row = (categoryIds: string[], optionIds: (string | null)[], workers: number, withProblems: number, hours: string, total: string) => ({
      categoryIds,
      optionIds,
      workers,
      withProblems,
      hours,
      total,
    });
    const both = [c.type.id, c.origin.id];
    const expected = [
      row([c.type.id], [Direkt], 2, 0, '450', '15000000.00'),
      row([c.type.id], [Endirekt], 2, 1, '225', '7500000.00'),
      row(both, [Direkt, Local], 1, 0, '225', '7500000.00'),
      row(both, [Direkt, Foreign], 1, 0, '225', '7500000.00'),
      row(both, [Endirekt, Local], 1, 1, '0', '0.00'),
      row(both, [Endirekt, null], 1, 0, '225', '7500000.00'),
      row([c.origin.id], [Local], 2, 1, '225', '7500000.00'),
      row([c.origin.id], [Foreign], 1, 0, '225', '7500000.00'),
      row([c.origin.id], [null], 1, 0, '225', '7500000.00'),
    ];
    const month = (await c.agent.get('/api/payroll/2026/9').expect(200)).body;
    expect(month.categories).toEqual(expected);
    expect(month.workers.find((w: { worker: { id: string } }) => w.worker.id === aliyev).categories).toEqual({
      [c.type.id]: Direkt,
      [c.origin.id]: Local,
    });

    // Locked with Toshev paid; a change after the lock doesn't move the locked month's totals.
    const toshev = (await c.agent.get('/api/workers').expect(200)).body.find((w: { lastName: string }) => w.lastName === 'Toshev').id;
    await c.agent.post(`/api/workers/${toshev}/salaries`).send({ fromYear: 2026, fromMonth: 9, monthlySalary: '7500000' }).expect(201);
    const placement = await ctx.prisma.assignment.findFirstOrThrow({ where: { workerId: toshev } });
    await c.agent.post(`/api/monthly-hours/2026/9/${placement.id}`).send(FULL_MONTH).expect(201);
    await c.agent.post('/api/payroll/2026/9/lock').expect(201);
    const locked = (await c.agent.get('/api/payroll/2026/9').expect(200)).body.categories;
    await c.agent.patch(`/api/workers/${aliyev}`).send(worker('Aliyev', { [c.type.id]: Endirekt })).expect(204);
    expect((await c.agent.get('/api/payroll/2026/9').expect(200)).body.categories).toEqual(locked);
    expect(locked[0]).toEqual(row([c.type.id], [Direkt], 2, 0, '450', '15000000.00'));
  });
});
