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

/** A worker's details; changed options start from October 2026 unless another month is given. */
const worker = (lastName: string, categories: Record<string, string | null>, categoriesFrom = { year: 2026, month: 10 }) => ({
  lastName,
  firstName: 'Test',
  categories,
  categoriesFrom,
});

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
    expect(log.data).toEqual({
      changes: { categories: { fromYear: 2026, fromMonth: 10, [c.type.id]: { from: c.type.options.Direkt, to: null } } },
    });

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
        data: { companyId: a.company.id, workerId: inA, categoryId: b.type.id, optionId: b.type.options.Direkt, fromYear: 2026, fromMonth: 9 },
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
    // A change can't reach the locked month; from the next month it can.
    const intoLocked = await c.agent
      .patch(`/api/workers/${aliyev}`)
      .send(worker('Aliyev', { [c.type.id]: Endirekt }, { year: 2026, month: 9 }))
      .expect(409);
    expect(intoLocked.body.code).toBe('period.locked');
    await c.agent.patch(`/api/workers/${aliyev}`).send(worker('Aliyev', { [c.type.id]: Endirekt })).expect(204);
    expect((await c.agent.get('/api/payroll/2026/9').expect(200)).body.categories).toEqual(locked);
    expect(locked[0]).toEqual(row([c.type.id], [Direkt], 2, 0, '450', '15000000.00'));
  });
  it('keeps each worker’s options from a month, so every month pays and groups with its own', async () => {
    const c = await company();
    const { Direkt, Endirekt } = c.type.options;
    const id = await paidWorker(c, 'Aliyev', { [c.type.id]: Direkt });
    // A change needs the month it starts from.
    const noMonth = await c.agent
      .patch(`/api/workers/${id}`)
      .send({ lastName: 'Aliyev', firstName: 'Test', categories: { [c.type.id]: Endirekt } })
      .expect(400);
    expect(noMonth.body.issues).toEqual([{ path: 'categoriesFrom', message: 'validation.required' }]);
    await c.agent.patch(`/api/workers/${id}`).send(worker('Aliyev', { [c.type.id]: Endirekt })).expect(204);

    // September keeps Direkt; from October, Endirekt.
    const september = (await c.agent.get('/api/payroll/2026/9').expect(200)).body;
    expect(september.workers[0].categories).toEqual({ [c.type.id]: Direkt });
    expect((await c.agent.get(`/api/workers/${id}`).expect(200)).body.categories).toEqual({ [c.type.id]: Endirekt });
    const history = (await c.agent.get(`/api/workers/${id}/categories`).expect(200)).body;
    expect(history.map((h: Record<string, unknown>) => [h.categoryId, h.optionId, h.fromYear, h.fromMonth])).toEqual([
      [c.type.id, Endirekt, 2026, 10],
      [c.type.id, Direkt, 2026, 9],
    ]);
    const other = await company();
    await other.agent.get(`/api/workers/${id}/categories`).expect(404);
  });
});

describe('rule sets split by categories', () => {
  const OWN_RULES = Object.fromEntries(Object.entries(RULES).filter(([k]) => k !== 'payRoundingStep'));
  const WITH_OVERTIME = { ...FULL_MONTH, overtimeHours: '10' };

  /** The company default rule set's id. */
  async function defaultSet(agent: Agent) {
    const sets = (await agent.get('/api/rule-sets').expect(200)).body as { id: string; name: string | null }[];
    return sets.find((s) => s.name === null)!.id;
  }

  /** Hires a worker with a salary for September; totals() enters September's hours. */
  async function hired(c: Awaited<ReturnType<typeof company>>, lastName: string, categories: Record<string, string | null>) {
    const id = (await hire(c.agent, c.site, lastName, categories).expect(201)).body.id as string;
    await c.agent.post(`/api/workers/${id}/salaries`).send({ fromYear: 2026, fromMonth: 9, monthlySalary: '7500000' }).expect(201);
    const placement = await ctx.prisma.assignment.findFirstOrThrow({ where: { workerId: id } });
    return { id, totals: () => c.agent.post(`/api/monthly-hours/2026/9/${placement.id}`).send(WITH_OVERTIME) };
  }

  const workerIn = (month: { workers: { worker: { id: string } }[] }, id: string) =>
    month.workers.find((w) => w.worker.id === id) as unknown as { total: string | null; parts: unknown[]; problems: unknown[] };

  it('pays each worker by the rules of their options’ combination, and never guesses a missing one', async () => {
    const c = await company();
    const { Direkt, Endirekt } = c.type.options;
    const set = await defaultSet(c.agent);
    const accountant = await member(c.company.id, 'ACCOUNTANT');
    await accountant.agent.put(`/api/rule-sets/${set}/splits/2026/9`).send({ categoryIds: [c.type.id] }).expect(403);
    await c.agent.put(`/api/rule-sets/${set}/splits/2026/9`).send({ categoryIds: [c.type.id] }).expect(204);
    expect((await accountant.agent.get(`/api/rule-sets/${set}/splits`).expect(200)).body).toMatchObject([
      { fromYear: 2026, fromMonth: 9, categoryIds: [c.type.id] },
    ]);

    // Direkt: overtime ×2; Endirekt: the set's own ×1.5.
    const direkt = (await c.agent.post(`/api/rule-sets/${set}/variants`).send({ optionIds: [Direkt] }).expect(201)).body.id;
    await c.agent.put(`/api/rule-sets/${direkt}/pay-rules/2026/9`).send({ ...OWN_RULES, overtimeMultiplier: '2' }).expect(204);
    const endirekt = (await c.agent.post(`/api/rule-sets/${set}/variants`).send({ optionIds: [Endirekt] }).expect(201)).body.id;
    await c.agent.put(`/api/rule-sets/${endirekt}/pay-rules/2026/9`).send(OWN_RULES).expect(204);
    const again = await c.agent.post(`/api/rule-sets/${set}/variants`).send({ optionIds: [Direkt] }).expect(409);
    expect(again.body.code).toBe('ruleSet.variantExists');
    expect((await c.agent.get(`/api/rule-sets/${set}/variants`).expect(200)).body).toEqual([
      { id: direkt, options: [{ categoryId: c.type.id, optionId: Direkt }], rulesFrom: { year: 2026, month: 9 } },
      { id: endirekt, options: [{ categoryId: c.type.id, optionId: Endirekt }], rulesFrom: { year: 2026, month: 9 } },
    ]);

    const aliyev = await hired(c, 'Aliyev', { [c.type.id]: Direkt });
    await aliyev.totals().expect(201);
    const karimov = await hired(c, 'Karimov', { [c.type.id]: Endirekt });
    await karimov.totals().expect(201);
    // Not set, or an option without rules: the totals can't be checked, and nothing is paid.
    const notSet = await hired(c, 'Sobirov', {});
    expect((await notSet.totals().expect(409)).body.code).toBe('ruleSet.categoryNotSet');
    const { id: kontrakt } = (await c.agent.post(`/api/worker-categories/${c.type.id}/options`).send({ name: 'Kontrakt' }).expect(201)).body;
    const noRules = await hired(c, 'Toshev', { [c.type.id]: kontrakt });
    expect((await noRules.totals().expect(409)).body.code).toBe('ruleSet.noCategoryRules');

    const month = (await c.agent.get('/api/payroll/2026/9').expect(200)).body;
    // Hourly rate 7 500 000 / (25 × 9); 10 overtime hours at ×2 = 666 666.67, at ×1.5 = 500 000.
    expect(workerIn(month, aliyev.id).total).toBe('8167000.00');
    expect(workerIn(month, aliyev.id).parts[0]).toMatchObject({
      ruleSetName: null,
      combination: [{ categoryName: 'Direkt / Endirekt', optionName: 'Direkt' }],
    });
    expect(workerIn(month, karimov.id).total).toBe('8000000.00');
    expect(workerIn(month, notSet.id).problems).toContainEqual({ code: 'categoryNotSet', ruleSetName: null, categoryIds: [c.type.id] });
    expect(workerIn(month, noRules.id).problems).toContainEqual({ code: 'noCategoryRules', ruleSetName: null, optionIds: [kontrakt] });

    // A category a set splits by now or later can't be closed.
    const inUse = await c.agent.patch(`/api/worker-categories/${c.type.id}`).send({ isActive: false }).expect(409);
    expect(inUse.body.code).toBe('workerCategory.inUse');
    await c.agent.put(`/api/rule-sets/${set}/splits/2026/12`).send({ categoryIds: [] }).expect(204);
    await c.agent.patch(`/api/worker-categories/${c.type.id}`).send({ isActive: false }).expect(409);
    // Without the split, the set's own rules pay again.
    await c.agent.delete(`/api/rule-sets/${set}/splits/2026/9`).expect(204);
    await c.agent.patch(`/api/worker-categories/${c.type.id}`).send({ isActive: false }).expect(204);
    expect(workerIn((await c.agent.get('/api/payroll/2026/9').expect(200)).body, aliyev.id).total).toBe('8000000.00');

    const log = await ctx.prisma.auditLog.findMany({
      where: { companyId: c.company.id, action: { startsWith: 'ruleSet.' } },
      orderBy: { createdAt: 'asc' },
    });
    expect(log.map((l) => l.action)).toEqual(['ruleSet.split', 'ruleSet.addVariant', 'ruleSet.addVariant', 'ruleSet.split', 'ruleSet.splitDelete']);
  });

  it('checks the categories of a split and keeps another company’s apart', async () => {
    const a = await company();
    const b = await company();
    const setA = await defaultSet(a.agent);
    const setB = await defaultSet(b.agent);
    const three = await a.agent
      .put(`/api/rule-sets/${setA}/splits/2026/9`)
      .send({ categoryIds: [a.type.id, a.origin.id, b.type.id] })
      .expect(400);
    expect(three.body.issues).toEqual([{ path: 'categoryIds', message: 'validation.twoCategoriesAtMost' }]);
    const twoOfOne = await a.agent
      .post(`/api/rule-sets/${setA}/variants`)
      .send({ optionIds: [a.type.options.Direkt, a.type.options.Endirekt] })
      .expect(400);
    expect(twoOfOne.body.issues).toEqual([{ path: 'optionIds', message: 'validation.categoryTwice' }]);
    await a.agent.put(`/api/rule-sets/${setA}/splits/2026/9`).send({ categoryIds: [a.type.id, a.origin.id] }).expect(204);
    const variant = (
      await a.agent.post(`/api/rule-sets/${setA}/variants`).send({ optionIds: [a.type.options.Direkt, a.origin.options.Local] }).expect(201)
    ).body.id;

    await b.agent.get(`/api/rule-sets/${setA}/splits`).expect(404);
    await b.agent.get(`/api/rule-sets/${setA}/variants`).expect(404);
    await b.agent.put(`/api/rule-sets/${setA}/splits/2026/10`).send({ categoryIds: [] }).expect(404);
    await b.agent.put(`/api/rule-sets/${setB}/splits/2026/9`).send({ categoryIds: [a.type.id] }).expect(404);
    await b.agent.post(`/api/rule-sets/${setB}/variants`).send({ optionIds: [a.type.options.Direkt] }).expect(404);
    await b.agent.put(`/api/rule-sets/${variant}/pay-rules/2026/9`).send(OWN_RULES).expect(404);
    await b.agent.get(`/api/rule-sets/${variant}/working-days?year=2026`).expect(404);
    // A combination is not a set that sites and firms choose.
    const use = await a.agent.put(`/api/sites/${a.site}/rule-set/2026/9`).send({ ruleSetId: variant }).expect(404);
    expect(use.body.code).toBe('ruleSet.notFound');
  });
});
