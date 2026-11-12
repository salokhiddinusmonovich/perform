import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import { addMember, createUser, loginAs, memberOfNewCompany, resetDb, setUpPay, startApp, type TestContext } from './helpers';

let ctx: TestContext;

beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

const RULES = {
  restWeekdays: [7],
  normalHoursPerDay: '9',
  overtimeMultiplier: '1.5',
  restDayMultiplier: '2',
  holidayMultiplier: '2',
  absence: {
    LEAVE: { paid: true, hoursPerDay: null },
    SICK: { paid: true, hoursPerDay: '8' },
    TRAVEL: { paid: true, hoursPerDay: null },
  },
  travelPayMode: 'NONE',
};

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

/** A company paying by the rule set "Main" (9-hour days) from September 2026, with two sites. */
async function company() {
  const owner = await memberOfNewCompany(ctx, 'OWNER');
  const pay = await setUpPay(owner.agent, RULES);
  const siteA = (await owner.agent.post('/api/sites').send({ name: 'Site A' }).expect(201)).body.id as string;
  const siteB = (await owner.agent.post('/api/sites').send({ name: 'Site B' }).expect(201)).body.id as string;
  return { ...owner, pay, siteA, siteB };
}

type Company = Awaited<ReturnType<typeof company>>;

/** A rule set with rules for the company's one combination from a month: 8-hour days unless asked otherwise. */
async function ruleSet(c: Company, name: string, normalHoursPerDay = '8', month = 9) {
  const id = (await c.agent.post('/api/rule-sets').send({ name }).expect(201)).body.id as string;
  const combination = (await c.agent.post(`/api/rule-sets/${id}/variants`).send({ optionIds: [c.pay.optionId] }).expect(201)).body.id;
  await c.agent.put(`/api/rule-sets/${combination}/pay-rules/2026/${month}`).send({ ...RULES, normalHoursPerDay }).expect(204);
  return { id, combination: combination as string };
}

async function worker(c: Company, siteId: string, firmId?: string) {
  const id = (
    await c.agent
      .post('/api/workers')
      .send({ worker: { lastName: 'Testov', firstName: 'Test', categories: c.pay.categories }, placement: { from: '2026-09-01', siteId, firmId } })
      .expect(201)
  ).body.id as string;
  await c.agent.post(`/api/workers/${id}/salaries`).send({ firmId: firmId ?? null, from: '2026-09-01', monthlySalary: '10000000' }).expect(201);
  return (await ctx.prisma.assignment.findFirstOrThrow({ where: { workerId: id } })).id;
}

/** The rule set name and hourly rate payroll used for a worker paid a full month at this many hours a day. */
async function pay(c: Company, placement: string, hoursPerDay: number) {
  await c.agent
    .post(`/api/monthly-hours/2026/9/${placement}`)
    .send(totals('2026-09-01', '2026-09-30', String(25 * hoursPerDay), 25))
    .expect(201);
  const view = (await c.agent.get('/api/payroll/2026/9').expect(200)).body.workers[0];
  expect(view.problems).toEqual([]);
  return { name: view.parts[0].ruleSetName as string | null, total: view.total as string };
}

async function member(companyId: string, role: Role) {
  const user = await createUser(ctx.prisma);
  await addMember(ctx.prisma, user.id, companyId, role);
  return { user, agent: await loginAs(ctx.app, user.email!) };
}

describe('which rule set applies', () => {
  it("uses the company's set when a site has none", async () => {
    const c = await company();
    const placement = await worker(c, c.siteA);
    expect(await pay(c, placement, 9)).toEqual({ name: 'Main', total: '10000000.00' });
  });

  it("uses the site's set over the company's", async () => {
    const c = await company();
    const { id: set } = await ruleSet(c, '8-hour days');
    await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/9`).send({ ruleSetId: set }).expect(204);
    const placement = await worker(c, c.siteA);
    expect(await pay(c, placement, 8)).toEqual({ name: '8-hour days', total: '10000000.00' });
  });

  it("uses the firm's set over the site's", async () => {
    const c = await company();
    const firm = (await c.agent.post('/api/firms').send({ name: 'Sub X', type: 'SUBCONTRACTOR' }).expect(201)).body.id as string;
    await c.agent.put('/api/firms/settings').send({ enabled: true }).expect(204);
    const { id: forSite } = await ruleSet(c, 'Site set');
    const { id: forFirm } = await ruleSet(c, 'Firm set', '10');
    await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/9`).send({ ruleSetId: forSite }).expect(204);
    await c.agent.put(`/api/firms/${firm}/rule-set/2026/9`).send({ ruleSetId: forFirm }).expect(204);
    const placement = await worker(c, c.siteA, firm);
    expect(await pay(c, placement, 10)).toEqual({ name: 'Firm set', total: '10000000.00' });
  });

  it("falls back to the site's set when the firm chose none of its own", async () => {
    const c = await company();
    const firm = (await c.agent.post('/api/firms').send({ name: 'Sub X', type: 'SUBCONTRACTOR' }).expect(201)).body.id as string;
    await c.agent.put('/api/firms/settings').send({ enabled: true }).expect(204);
    const { id: forSite } = await ruleSet(c, 'Site set');
    await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/9`).send({ ruleSetId: forSite }).expect(204);
    await c.agent.put(`/api/firms/${firm}/rule-set/2026/9`).send({ ruleSetId: null }).expect(204);
    const placement = await worker(c, c.siteA, firm);
    expect((await pay(c, placement, 8)).name).toBe('Site set');
  });

  it('lets two sites share one set, and a change reaches both', async () => {
    const c = await company();
    const { id: set, combination } = await ruleSet(c, 'Shared');
    await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/9`).send({ ruleSetId: set }).expect(204);
    await c.agent.put(`/api/sites/${c.siteB}/rule-set/2026/9`).send({ ruleSetId: set }).expect(204);

    const list = (await c.agent.get('/api/rule-sets').expect(200)).body as { id: string; usedBy: { company: boolean; sites: { name: string }[] } }[];
    expect(list.find((s) => s.id === set)!.usedBy).toMatchObject({ company: false, sites: [{ name: 'Site A' }, { name: 'Site B' }] });
    expect(list.find((s) => s.id === c.pay.ruleSetId)!.usedBy).toMatchObject({ company: true, sites: [] });

    await c.agent.put(`/api/rule-sets/${combination}/pay-rules/2026/9`).send({ ...RULES, normalHoursPerDay: '7' }).expect(204);
    const a = await worker(c, c.siteA);
    expect((await pay(c, a, 7)).total).toBe('10000000.00');
  });

  it('keeps earlier months on the rules they had', async () => {
    const c = await company();
    const { id: set } = await ruleSet(c, 'From October', '8', 10);
    await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/10`).send({ ruleSetId: set }).expect(204);
    const placement = await worker(c, c.siteA);
    // September comes before the choice: the company's set, 9 hours.
    expect(await pay(c, placement, 9)).toEqual({ name: 'Main', total: '10000000.00' });
  });
});

describe('choosing a rule set', () => {
  it('refuses a set without rules for that month, an inactive one, and removing rules in use', async () => {
    const c = await company();
    const { id: set, combination } = await ruleSet(c, 'From October', '8', 10);
    const early = await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/9`).send({ ruleSetId: set }).expect(409);
    expect(early.body.code).toBe('ruleSet.noRulesForMonth');

    await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/10`).send({ ruleSetId: set }).expect(204);
    const removing = await c.agent.delete(`/api/rule-sets/${combination}/pay-rules/2026/10`).expect(409);
    expect(removing.body.code).toBe('ruleSet.inUse');
    const off = await c.agent.patch(`/api/rule-sets/${set}`).send({ isActive: false }).expect(409);
    expect(off.body.code).toBe('ruleSet.inUse');

    await c.agent.delete(`/api/sites/${c.siteA}/rule-set/2026/10`).expect(204);
    await c.agent.patch(`/api/rule-sets/${set}`).send({ isActive: false }).expect(204);
    const inactive = await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/10`).send({ ruleSetId: set }).expect(409);
    expect(inactive.body.code).toBe('ruleSet.inactive');
  });

  it('refuses a choice reaching a locked month', async () => {
    const c = await company();
    const { id: set } = await ruleSet(c, 'Set');
    const user = await createUser(ctx.prisma);
    await ctx.prisma.payrollPeriod.create({
      data: { companyId: c.company.id, year: 2026, month: 9, status: 'LOCKED', lockedAt: new Date(), lockedById: user.id },
    });
    await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/9`).send({ ruleSetId: set }).expect(409);
  });

  it('keeps names unique ignoring case, and records who did what', async () => {
    const c = await company();
    const { id: set } = await ruleSet(c, 'Shared');
    const taken = await c.agent.post('/api/rule-sets').send({ name: 'SHARED' }).expect(409);
    expect(taken.body.code).toBe('ruleSet.nameTaken');
    await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/9`).send({ ruleSetId: set }).expect(204);
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { companyId: c.company.id, action: 'ruleSet.use' }, orderBy: { createdAt: 'desc' } });
    expect(log.data).toEqual({ siteId: c.siteA, fromYear: 2026, fromMonth: 9, from: null, to: set });
  });

  it('always gives the company a set: never none, and only one with rules for the month', async () => {
    const c = await company();
    const { id: later } = await ruleSet(c, 'From October', '8', 10);
    const none = await c.agent.put('/api/company/rule-set/2026/10').send({ ruleSetId: null }).expect(400);
    expect(none.body.issues).toEqual([{ path: 'ruleSetId', message: 'validation.required' }]);
    expect((await c.agent.put('/api/company/rule-set/2026/9').send({ ruleSetId: later }).expect(409)).body.code).toBe('ruleSet.noRulesForMonth');
    await c.agent.put('/api/company/rule-set/2026/10').send({ ruleSetId: later }).expect(204);
    const uses = (await c.agent.get('/api/company/rule-set').expect(200)).body as { fromMonth: number; ruleSet: { name: string } }[];
    expect(uses.map((u) => [u.fromMonth, u.ruleSet.name])).toEqual([
      [10, 'From October'],
      [9, 'Main'],
    ]);
    // A month without a set chosen by anyone pays nobody.
    await c.agent.delete('/api/company/rule-set/2026/9').expect(204);
    const placement = await worker(c, c.siteA);
    const res = await c.agent.post(`/api/monthly-hours/2026/9/${placement}`).send(totals('2026-09-01', '2026-09-30', '225', 25)).expect(409);
    expect(res.body.code).toBe('payRules.notSet');
  });

  it('needs rules of a combination of the pay categories of the month', async () => {
    const c = await company();
    const origin = (await c.agent.post('/api/worker-categories').send({ name: 'Origin', options: ['Local', 'Foreign'] }).expect(201)).body;
    const local = (await c.agent.get('/api/worker-categories').expect(200)).body.find((x: { id: string }) => x.id === origin.id).options[0].id;
    await c.agent.put('/api/pay-categories/2026/10').send({ categoryIds: [origin.id] }).expect(204);
    await c.agent.put('/api/pay-categories/2026/12').send({ categoryIds: [c.pay.categoryId, origin.id] }).expect(204);
    const { id: set } = await ruleSet(c, 'Set');
    const both = (await c.agent.post(`/api/rule-sets/${set}/variants`).send({ optionIds: [c.pay.optionId, local] }).expect(201)).body.id;
    await c.agent.put(`/api/rule-sets/${both}/pay-rules/2026/9`).send(RULES).expect(204);
    // The set has rules for "Pay group", and for "Pay group" with Origin: in October the company pays by Origin alone.
    await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/9`).send({ ruleSetId: set }).expect(204);
    const res = await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/10`).send({ ruleSetId: set }).expect(409);
    expect(res.body.code).toBe('ruleSet.noRulesForMonth');
    await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/12`).send({ ruleSetId: set }).expect(204);
  });

  it('overrides the working days of the combination alone', async () => {
    const c = await company();
    const { combination } = await ruleSet(c, 'Set');
    await c.agent.post(`/api/rule-sets/${combination}/working-days/2026/9`).send({ workingDays: 20, reason: 'Short month' }).expect(204);
    expect((await c.agent.get(`/api/rule-sets/${combination}/working-days?year=2026`).expect(200)).body.months[8].effective).toBe(20);
    expect((await c.agent.get(`/api/rule-sets/${c.pay.combinationId}/working-days?year=2026`).expect(200)).body.months[8].effective).toBe(25);
  });
});

describe('who may', () => {
  it('lets only owners and admins change; accountants view; others see nothing', async () => {
    const c = await company();
    const { id: set, combination } = await ruleSet(c, 'Set');
    const accountant = await member(c.company.id, 'ACCOUNTANT');
    const timekeeper = await member(c.company.id, 'TIMEKEEPER');

    await accountant.agent.get('/api/rule-sets').expect(200);
    await accountant.agent.get(`/api/sites/${c.siteA}/rule-set`).expect(200);
    await accountant.agent.post('/api/rule-sets').send({ name: 'Other' }).expect(403);
    await accountant.agent.patch(`/api/rule-sets/${set}`).send({ name: 'New' }).expect(403);
    await accountant.agent.put(`/api/rule-sets/${combination}/pay-rules/2026/9`).send(RULES).expect(403);
    await accountant.agent.post(`/api/rule-sets/${set}/variants`).send({ optionIds: [c.pay.optionId] }).expect(403);
    await accountant.agent.put(`/api/sites/${c.siteA}/rule-set/2026/9`).send({ ruleSetId: set }).expect(403);
    await accountant.agent.put('/api/company/rule-set/2026/9').send({ ruleSetId: set }).expect(403);
    // Accountants add working-day overrides.
    await accountant.agent.post(`/api/rule-sets/${combination}/working-days/2026/9`).send({ workingDays: 24 }).expect(204);

    await timekeeper.agent.get('/api/rule-sets').expect(403);
    await timekeeper.agent.get(`/api/rule-sets/${combination}/pay-rules`).expect(403);
    await timekeeper.agent.get(`/api/sites/${c.siteA}/rule-set`).expect(403);
  });

  it("keeps another company's rule sets apart", async () => {
    const a = await company();
    const b = await company();
    const { id: set, combination } = await ruleSet(b, 'B set');

    expect((await a.agent.get('/api/rule-sets').expect(200)).body.map((s: { id: string }) => s.id)).not.toContain(set);
    await a.agent.get(`/api/rule-sets/${combination}/pay-rules`).expect(404);
    await a.agent.put(`/api/rule-sets/${combination}/pay-rules/2026/9`).send(RULES).expect(404);
    await a.agent.patch(`/api/rule-sets/${set}`).send({ name: 'Stolen' }).expect(404);
    await a.agent.get(`/api/rule-sets/${combination}/working-days?year=2026`).expect(404);
    await a.agent.get(`/api/rule-sets/${set}/variants`).expect(404);
    await a.agent.post(`/api/rule-sets/${set}/variants`).send({ optionIds: [a.pay.optionId] }).expect(404);
    await a.agent.post(`/api/rule-sets/${a.pay.ruleSetId}/variants`).send({ optionIds: [b.pay.optionId] }).expect(404);
    await a.agent.put('/api/company/rule-set/2026/9').send({ ruleSetId: set }).expect(404);
    // Neither their set on our site, nor our choice on their site.
    await a.agent.put(`/api/sites/${a.siteA}/rule-set/2026/9`).send({ ruleSetId: set }).expect(404);
    await a.agent.put(`/api/sites/${b.siteA}/rule-set/2026/9`).send({ ruleSetId: null }).expect(404);
    await a.agent.get(`/api/sites/${b.siteA}/rule-set`).expect(404);

    const user = await createUser(ctx.prisma);
    await expect(
      ctx.prisma.ruleSetUse.create({
        data: { companyId: a.company.id, siteId: a.siteA, ruleSetId: set, fromYear: 2026, fromMonth: 9, setById: user.id },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
  });
});
