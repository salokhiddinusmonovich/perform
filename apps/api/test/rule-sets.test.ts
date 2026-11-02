import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import { addMember, createUser, loginAs, memberOfNewCompany, resetDb, startApp, type TestContext } from './helpers';

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

async function company() {
  const owner = await memberOfNewCompany(ctx, 'OWNER');
  await owner.agent.put('/api/pay-rules/2026/9').send({ ...RULES, payRoundingStep: '1000' }).expect(204);
  const siteA = (await owner.agent.post('/api/sites').send({ name: 'Site A' }).expect(201)).body.id as string;
  const siteB = (await owner.agent.post('/api/sites').send({ name: 'Site B' }).expect(201)).body.id as string;
  return { ...owner, siteA, siteB };
}

type Company = Awaited<ReturnType<typeof company>>;

/** A named set with rules from a month: 8-hour days unless asked otherwise. */
async function ruleSet(c: Company, name: string, normalHoursPerDay = '8', month = 9) {
  const id = (await c.agent.post('/api/rule-sets').send({ name }).expect(201)).body.id as string;
  await c.agent.put(`/api/rule-sets/${id}/pay-rules/2026/${month}`).send({ ...RULES, normalHoursPerDay }).expect(204);
  return id;
}

async function worker(c: Company, siteId: string, firmId?: string) {
  const id = (
    await c.agent
      .post('/api/workers')
      .send({ worker: { lastName: 'Testov', firstName: 'Test', employmentType: 'DIRECT' }, placement: { from: '2026-09-01', siteId, firmId } })
      .expect(201)
  ).body.id as string;
  await c.agent.post(`/api/workers/${id}/salaries`).send({ firmId: firmId ?? null, fromYear: 2026, fromMonth: 9, monthlySalary: '10000000' }).expect(201);
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
  it('uses the company default when a site has none', async () => {
    const c = await company();
    const placement = await worker(c, c.siteA);
    expect(await pay(c, placement, 9)).toEqual({ name: null, total: '10000000.00' });
  });

  it("uses the site's set over the company default", async () => {
    const c = await company();
    const set = await ruleSet(c, '8-hour days');
    await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/9`).send({ ruleSetId: set }).expect(204);
    const placement = await worker(c, c.siteA);
    expect(await pay(c, placement, 8)).toEqual({ name: '8-hour days', total: '10000000.00' });
  });

  it("uses the firm's set over the site's", async () => {
    const c = await company();
    const firm = (await c.agent.post('/api/firms').send({ name: 'Sub X', type: 'SUBCONTRACTOR' }).expect(201)).body.id as string;
    await c.agent.put('/api/firms/settings').send({ enabled: true }).expect(204);
    const forSite = await ruleSet(c, 'Site set');
    const forFirm = await ruleSet(c, 'Firm set', '10');
    await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/9`).send({ ruleSetId: forSite }).expect(204);
    await c.agent.put(`/api/firms/${firm}/rule-set/2026/9`).send({ ruleSetId: forFirm }).expect(204);
    const placement = await worker(c, c.siteA, firm);
    expect(await pay(c, placement, 10)).toEqual({ name: 'Firm set', total: '10000000.00' });
  });

  it("falls back to the site's set when the firm chose none of its own", async () => {
    const c = await company();
    const firm = (await c.agent.post('/api/firms').send({ name: 'Sub X', type: 'SUBCONTRACTOR' }).expect(201)).body.id as string;
    await c.agent.put('/api/firms/settings').send({ enabled: true }).expect(204);
    const forSite = await ruleSet(c, 'Site set');
    await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/9`).send({ ruleSetId: forSite }).expect(204);
    await c.agent.put(`/api/firms/${firm}/rule-set/2026/9`).send({ ruleSetId: null }).expect(204);
    const placement = await worker(c, c.siteA, firm);
    expect((await pay(c, placement, 8)).name).toBe('Site set');
  });

  it('lets two sites share one set, and a change reaches both', async () => {
    const c = await company();
    const set = await ruleSet(c, 'Shared');
    await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/9`).send({ ruleSetId: set }).expect(204);
    await c.agent.put(`/api/sites/${c.siteB}/rule-set/2026/9`).send({ ruleSetId: set }).expect(204);

    const list = (await c.agent.get('/api/rule-sets').expect(200)).body as { id: string; usedBy: { sites: { name: string }[] } }[];
    expect(list.find((s) => s.id === set)!.usedBy.sites.map((s) => s.name)).toEqual(['Site A', 'Site B']);

    await c.agent.put(`/api/rule-sets/${set}/pay-rules/2026/9`).send({ ...RULES, normalHoursPerDay: '7' }).expect(204);
    const a = await worker(c, c.siteA);
    expect((await pay(c, a, 7)).total).toBe('10000000.00');
  });

  it('keeps earlier months on the rules they had', async () => {
    const c = await company();
    const set = await ruleSet(c, 'From October', '8', 10);
    await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/10`).send({ ruleSetId: set }).expect(204);
    const placement = await worker(c, c.siteA);
    // September comes before the choice: the company default, 9 hours.
    expect(await pay(c, placement, 9)).toEqual({ name: null, total: '10000000.00' });
  });
});

describe('choosing a rule set', () => {
  it('refuses a set without rules for that month, an inactive one, and removing rules in use', async () => {
    const c = await company();
    const set = await ruleSet(c, 'From October', '8', 10);
    const early = await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/9`).send({ ruleSetId: set }).expect(409);
    expect(early.body.code).toBe('ruleSet.noRulesForMonth');

    await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/10`).send({ ruleSetId: set }).expect(204);
    const removing = await c.agent.delete(`/api/rule-sets/${set}/pay-rules/2026/10`).expect(409);
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
    const set = await ruleSet(c, 'Set');
    const user = await createUser(ctx.prisma);
    await ctx.prisma.payrollPeriod.create({
      data: { companyId: c.company.id, year: 2026, month: 9, status: 'LOCKED', lockedAt: new Date(), lockedById: user.id },
    });
    await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/9`).send({ ruleSetId: set }).expect(409);
  });

  it('keeps names unique ignoring case, and records who did what', async () => {
    const c = await company();
    const set = await ruleSet(c, 'Shared');
    const taken = await c.agent.post('/api/rule-sets').send({ name: 'SHARED' }).expect(409);
    expect(taken.body.code).toBe('ruleSet.nameTaken');
    await c.agent.put(`/api/sites/${c.siteA}/rule-set/2026/9`).send({ ruleSetId: set }).expect(204);
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { companyId: c.company.id, action: 'ruleSet.use' } });
    expect(log.data).toEqual({ siteId: c.siteA, fromYear: 2026, fromMonth: 9, from: null, to: set });
  });

  it('keeps the rounding step company-wide, on the default alone', async () => {
    const c = await company();
    const set = await ruleSet(c, 'Set');
    await c.agent.put(`/api/rule-sets/${set}/pay-rules/2026/9`).send({ ...RULES, payRoundingStep: '5' }).expect(204);
    const stored = await ctx.prisma.payrollRules.findFirstOrThrow({ where: { ruleSetId: set } });
    expect(stored.payRoundingStep).toBeNull();
  });

  it('overrides the working days of the set alone', async () => {
    const c = await company();
    const set = await ruleSet(c, 'Set');
    await c.agent.post(`/api/rule-sets/${set}/working-days/2026/9`).send({ workingDays: 20, reason: 'Short month' }).expect(204);
    expect((await c.agent.get(`/api/rule-sets/${set}/working-days?year=2026`).expect(200)).body.months[8].effective).toBe(20);
    expect((await c.agent.get('/api/working-days?year=2026').expect(200)).body.months[8].effective).toBe(25);
  });
});

describe('who may', () => {
  it('lets only owners and admins change; accountants view; others see nothing', async () => {
    const c = await company();
    const set = await ruleSet(c, 'Set');
    const accountant = await member(c.company.id, 'ACCOUNTANT');
    const timekeeper = await member(c.company.id, 'TIMEKEEPER');

    await accountant.agent.get('/api/rule-sets').expect(200);
    await accountant.agent.get(`/api/sites/${c.siteA}/rule-set`).expect(200);
    await accountant.agent.post('/api/rule-sets').send({ name: 'Other' }).expect(403);
    await accountant.agent.patch(`/api/rule-sets/${set}`).send({ name: 'New' }).expect(403);
    await accountant.agent.put(`/api/rule-sets/${set}/pay-rules/2026/9`).send(RULES).expect(403);
    await accountant.agent.put(`/api/sites/${c.siteA}/rule-set/2026/9`).send({ ruleSetId: set }).expect(403);

    await timekeeper.agent.get('/api/rule-sets').expect(403);
    await timekeeper.agent.get(`/api/rule-sets/${set}/pay-rules`).expect(403);
    await timekeeper.agent.get(`/api/sites/${c.siteA}/rule-set`).expect(403);
  });

  it("keeps another company's rule sets apart", async () => {
    const a = await company();
    const b = await company();
    const set = await ruleSet(b, 'B set');

    expect((await a.agent.get('/api/rule-sets').expect(200)).body.map((s: { id: string }) => s.id)).not.toContain(set);
    await a.agent.get(`/api/rule-sets/${set}/pay-rules`).expect(404);
    await a.agent.put(`/api/rule-sets/${set}/pay-rules/2026/9`).send(RULES).expect(404);
    await a.agent.patch(`/api/rule-sets/${set}`).send({ name: 'Stolen' }).expect(404);
    await a.agent.get(`/api/rule-sets/${set}/working-days?year=2026`).expect(404);
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
