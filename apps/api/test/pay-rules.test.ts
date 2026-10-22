import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addMember, createUser, loginAs, memberOfNewCompany, resetDb, startApp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

/** Valid rules as a form sends them. */
const RULES = {
  restWeekdays: [7],
  normalHoursPerDay: '9',
  overtimeMultiplier: '1,5',
  restDayMultiplier: '2',
  holidayMultiplier: '2',
  absence: {
    LEAVE: { paid: true, hoursPerDay: '' },
    SICK: { paid: true, hoursPerDay: '8' },
    TRAVEL: { paid: false, hoursPerDay: null },
  },
  travelPayMode: 'NONE',
  payRoundingStep: '1000',
};

async function lock(companyId: string, year: number, month: number) {
  const user = await createUser(ctx.prisma);
  await ctx.prisma.payrollPeriod.create({
    data: { companyId, year, month, status: 'LOCKED', lockedAt: new Date(), lockedById: user.id },
  });
}

describe('pay rules', () => {
  it('saves rules from a month, normalized, with an audit record', async () => {
    const { company, user, agent } = await memberOfNewCompany(ctx, 'ADMIN');
    expect((await agent.get('/api/pay-rules').expect(200)).body).toEqual([]);

    await agent.put('/api/pay-rules/2026/1').send(RULES).expect(204);
    const res = await agent.get('/api/pay-rules').expect(200);
    expect(res.body).toEqual([
      {
        fromYear: 2026,
        fromMonth: 1,
        rules: {
          ...RULES,
          overtimeMultiplier: '1.5',
          absence: {
            LEAVE: { paid: true, hoursPerDay: null },
            SICK: { paid: true, hoursPerDay: '8' },
            TRAVEL: { paid: false, hoursPerDay: null },
          },
        },
        setBy: { fullName: user.fullName },
        setAt: expect.any(String),
      },
    ]);
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'payRules.set', companyId: company.id } });
    expect(log.actorUserId).toBe(user.id);
    expect(log.data).toMatchObject({ fromYear: 2026, fromMonth: 1, before: null, after: { overtimeMultiplier: '1.5' } });
  });

  it('keeps older months on the rules they had', async () => {
    const { agent } = await memberOfNewCompany(ctx, 'OWNER');
    await agent.put('/api/pay-rules/2026/1').send(RULES).expect(204);
    await agent.put('/api/pay-rules/2026/11').send({ ...RULES, restWeekdays: [6, 7], overtimeMultiplier: '2' }).expect(204);

    const versions = (await agent.get('/api/pay-rules').expect(200)).body;
    expect(versions.map((v: { fromMonth: number; rules: { overtimeMultiplier: string } }) => [v.fromMonth, v.rules.overtimeMultiplier])).toEqual([
      [11, '2'],
      [1, '1.5'],
    ]);

    // October 2026: 4 Sundays and Teachers' Day on a Thursday (31 − 4 − 1 = 26).
    // November 2026 under the new rules: 4 Saturdays and 5 Sundays (30 − 9 = 21).
    const year = (await agent.get('/api/working-days?year=2026').expect(200)).body;
    expect(year.months[9]).toMatchObject({ month: 10, rulesFrom: { year: 2026, month: 1 }, calculated: 26 });
    expect(year.months[10]).toMatchObject({ month: 11, rulesFrom: { year: 2026, month: 11 }, calculated: 21 });
  });

  it('replaces the version of the same month, and removes one', async () => {
    const { agent } = await memberOfNewCompany(ctx, 'OWNER');
    await agent.put('/api/pay-rules/2026/1').send(RULES).expect(204);
    await agent.put('/api/pay-rules/2026/1').send({ ...RULES, holidayMultiplier: '3' }).expect(204);
    await agent.put('/api/pay-rules/2026/5').send(RULES).expect(204);
    expect((await agent.get('/api/pay-rules').expect(200)).body).toHaveLength(2);

    await agent.delete('/api/pay-rules/2026/5').expect(204);
    const versions = (await agent.get('/api/pay-rules').expect(200)).body;
    expect(versions).toHaveLength(1);
    expect(versions[0].rules.holidayMultiplier).toBe('3');
    expect((await agent.delete('/api/pay-rules/2026/5').expect(404)).body.code).toBe('payRules.notFound');
  });

  it('refuses a change that would alter a locked month', async () => {
    const { company, agent } = await memberOfNewCompany(ctx, 'OWNER');
    await agent.put('/api/pay-rules/2026/1').send(RULES).expect(204);
    await agent.put('/api/pay-rules/2026/9').send(RULES).expect(204);
    await lock(company.id, 2026, 3);

    // From February, the version would reach March.
    expect((await agent.put('/api/pay-rules/2026/2').send(RULES).expect(409)).body.code).toBe('period.locked');
    expect((await agent.put('/api/pay-rules/2026/1').send(RULES).expect(409)).body.code).toBe('period.locked');
    expect((await agent.delete('/api/pay-rules/2026/1').expect(409)).body.code).toBe('period.locked');
    // April on is not locked, and September's version ends before nothing locked.
    await agent.put('/api/pay-rules/2026/4').send(RULES).expect(204);
    await agent.delete('/api/pay-rules/2026/9').expect(204);
  });

  it('returns per-field validation errors and has no defaults for the multipliers', async () => {
    const { agent } = await memberOfNewCompany(ctx, 'OWNER');
    const res = await agent
      .put('/api/pay-rules/2026/1')
      .send({ ...RULES, overtimeMultiplier: '', normalHoursPerDay: '25', restWeekdays: [1, 2, 3, 4, 5, 6, 7] })
      .expect(400);
    expect(res.body.issues).toEqual(
      expect.arrayContaining([
        { path: 'overtimeMultiplier', message: 'validation.required' },
        { path: 'normalHoursPerDay', message: 'validation.normalHoursRange' },
        { path: 'restWeekdays', message: 'validation.restWeekdaysAllWeek' },
      ]),
    );
    await agent.put('/api/pay-rules/2026/13').send(RULES).expect(400);
  });

  it('lets accountants see the rules but only owners and admins change them', async () => {
    const { agent } = await memberOfNewCompany(ctx, 'ACCOUNTANT');
    await agent.get('/api/pay-rules').expect(200);
    await agent.put('/api/pay-rules/2026/1').send(RULES).expect(403);
    await agent.delete('/api/pay-rules/2026/1').expect(403);

    for (const role of ['TIMEKEEPER', 'FOREMAN'] as const) {
      const other = await memberOfNewCompany(ctx, role);
      await other.agent.get('/api/pay-rules').expect(403);
      await other.agent.get('/api/holidays?year=2026').expect(403);
      await other.agent.get('/api/working-days?year=2026').expect(403);
    }
  });
});

describe('holidays', () => {
  it('shows the fixed holidays and warns about missing moving ones', async () => {
    const { agent } = await memberOfNewCompany(ctx, 'ADMIN');
    const empty = (await agent.get('/api/holidays?year=2026').expect(200)).body;
    expect(empty.fixed).toContainEqual({ date: '2026-03-21', key: 'NAVRUZ' });
    expect(empty.entered).toEqual([]);
    expect(empty.missingMovingHolidays).toEqual(['RAMAZON_HAYIT', 'QURBON_HAYIT']);

    await agent.post('/api/holidays').send({ date: '2026-03-20', kind: 'RAMAZON_HAYIT' }).expect(201);
    await agent.post('/api/holidays').send({ date: '2026-05-27', kind: 'QURBON_HAYIT', name: '' }).expect(201);
    const full = (await agent.get('/api/holidays?year=2026').expect(200)).body;
    expect(full.missingMovingHolidays).toEqual([]);
    expect(full.entered).toEqual([
      { id: expect.any(String), date: '2026-03-20', kind: 'RAMAZON_HAYIT', name: null },
      { id: expect.any(String), date: '2026-05-27', kind: 'QURBON_HAYIT', name: null },
    ]);
    // Another year is still incomplete.
    expect((await agent.get('/api/holidays?year=2027').expect(200)).body.missingMovingHolidays).toHaveLength(2);
  });

  it('refuses fixed dates, a second holiday on a day, and a second Ramazon Hayit in a year', async () => {
    const { agent } = await memberOfNewCompany(ctx, 'OWNER');
    const fixed = await agent.post('/api/holidays').send({ date: '2026-01-01', kind: 'WORKING_DAY' }).expect(409);
    expect(fixed.body.code).toBe('holiday.fixedDate');

    await agent.post('/api/holidays').send({ date: '2026-03-20', kind: 'RAMAZON_HAYIT' }).expect(201);
    const taken = await agent.post('/api/holidays').send({ date: '2026-03-20', kind: 'COMPANY_DAY_OFF' }).expect(409);
    expect(taken.body.code).toBe('holiday.dateTaken');
    const twice = await agent.post('/api/holidays').send({ date: '2026-03-23', kind: 'RAMAZON_HAYIT' }).expect(409);
    expect(twice.body.code).toBe('holiday.movingAlreadyEntered');
    // Extra days around it are PUBLIC_EXTRA.
    await agent.post('/api/holidays').send({ date: '2026-03-23', kind: 'PUBLIC_EXTRA', name: 'Extra day' }).expect(201);
  });

  it('changes and removes a holiday, with audit records', async () => {
    const { company, agent } = await memberOfNewCompany(ctx, 'OWNER');
    const { id } = (await agent.post('/api/holidays').send({ date: '2026-06-01', kind: 'COMPANY_DAY_OFF' }).expect(201)).body;
    await agent.put(`/api/holidays/${id}`).send({ date: '2026-06-02', kind: 'COMPANY_DAY_OFF', name: 'Founders day' }).expect(204);
    expect((await agent.get('/api/holidays?year=2026').expect(200)).body.entered).toEqual([
      { id, date: '2026-06-02', kind: 'COMPANY_DAY_OFF', name: 'Founders day' },
    ]);
    await agent.delete(`/api/holidays/${id}`).expect(204);
    expect((await agent.get('/api/holidays?year=2026').expect(200)).body.entered).toEqual([]);

    const actions = (await ctx.prisma.auditLog.findMany({ where: { companyId: company.id }, orderBy: { createdAt: 'asc' } })).map(
      (l) => l.action,
    );
    expect(actions).toEqual(['holiday.create', 'holiday.update', 'holiday.delete']);
  });

  it('refuses changes in a locked month, in either the old or the new month', async () => {
    const { company, agent } = await memberOfNewCompany(ctx, 'OWNER');
    const { id } = (await agent.post('/api/holidays').send({ date: '2026-06-01', kind: 'COMPANY_DAY_OFF' }).expect(201)).body;
    await lock(company.id, 2026, 7);
    expect((await agent.post('/api/holidays').send({ date: '2026-07-01', kind: 'COMPANY_DAY_OFF' }).expect(409)).body.code).toBe(
      'period.locked',
    );
    await agent.put(`/api/holidays/${id}`).send({ date: '2026-07-02', kind: 'COMPANY_DAY_OFF' }).expect(409);

    await lock(company.id, 2026, 6);
    await agent.put(`/api/holidays/${id}`).send({ date: '2026-05-04', kind: 'COMPANY_DAY_OFF' }).expect(409);
    await agent.delete(`/api/holidays/${id}`).expect(409);
  });

  it('lets accountants see holidays but not change them', async () => {
    const { agent } = await memberOfNewCompany(ctx, 'ACCOUNTANT');
    await agent.get('/api/holidays?year=2026').expect(200);
    await agent.post('/api/holidays').send({ date: '2026-06-01', kind: 'COMPANY_DAY_OFF' }).expect(403);
  });
});

describe('working days', () => {
  it('calculates working days from rest weekdays and holidays, swaps included', async () => {
    const { agent } = await memberOfNewCompany(ctx, 'OWNER');
    const before = (await agent.get('/api/working-days?year=2026').expect(200)).body;
    expect(before.months[5]).toMatchObject({ month: 6, rulesFrom: null, calculated: null, effective: null });

    await agent.put('/api/pay-rules/2026/1').send({ ...RULES, restWeekdays: [6, 7] }).expect(204);
    // June 2026: 22 weekdays. A company day off on Monday the 1st, and Saturday the 6th made a working day.
    await agent.post('/api/holidays').send({ date: '2026-06-01', kind: 'COMPANY_DAY_OFF' }).expect(201);
    await agent.post('/api/holidays').send({ date: '2026-06-06', kind: 'WORKING_DAY' }).expect(201);
    const june = (await agent.get('/api/working-days?year=2026').expect(200)).body.months[5];
    expect(june).toMatchObject({ calculated: 22, override: null, effective: 22, locked: false, history: [] });
  });

  it('adds overrides without changing old ones; the newest counts', async () => {
    const { company, user, agent } = await memberOfNewCompany(ctx, 'ACCOUNTANT');
    const owner = await createUser(ctx.prisma);
    await addMember(ctx.prisma, owner.id, company.id, 'OWNER');
    const ownerAgent = await loginAs(ctx.app, owner.email!);
    await ownerAgent.put('/api/pay-rules/2026/1').send(RULES).expect(204);

    expect((await agent.post('/api/working-days/2026/6').send({ workingDays: null }).expect(409)).body.code).toBe(
      'workingDays.unchanged',
    );
    await agent.post('/api/working-days/2026/6').send({ workingDays: 24, reason: 'Order No. 5' }).expect(204);
    await agent.post('/api/working-days/2026/6').send({ workingDays: 25 }).expect(204);
    let june = (await agent.get('/api/working-days?year=2026').expect(200)).body.months[5];
    expect(june).toMatchObject({ calculated: 26, override: 25, effective: 25 });
    expect(june.history).toEqual([
      { workingDays: 25, reason: null, setBy: { fullName: user.fullName }, setAt: expect.any(String) },
      { workingDays: 24, reason: 'Order No. 5', setBy: { fullName: user.fullName }, setAt: expect.any(String) },
    ]);

    // Back to the calculated value is a newer row too.
    await agent.post('/api/working-days/2026/6').send({ workingDays: null, reason: 'Mistake' }).expect(204);
    june = (await agent.get('/api/working-days?year=2026').expect(200)).body.months[5];
    expect(june).toMatchObject({ calculated: 26, override: null, effective: 26 });
    expect(june.history).toHaveLength(3);
    expect(await ctx.prisma.workingDaysOverride.count()).toBe(3);

    const log = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'workingDays.override', companyId: company.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(log.data).toMatchObject({ year: 2026, month: 6, calculated: 26, from: 25, to: null, reason: 'Mistake' });
  });

  it('refuses overrides without rules, above the days of the month, or in a locked month', async () => {
    const { company, agent } = await memberOfNewCompany(ctx, 'OWNER');
    expect((await agent.post('/api/working-days/2026/2').send({ workingDays: 20 }).expect(409)).body.code).toBe(
      'payRules.notSet',
    );
    await agent.put('/api/pay-rules/2026/1').send(RULES).expect(204);
    const tooMany = await agent.post('/api/working-days/2026/2').send({ workingDays: 29 }).expect(400);
    expect(tooMany.body.issues).toEqual([{ path: 'workingDays', message: 'validation.workingDaysRange' }]);
    await agent.post('/api/working-days/2026/2').send({ workingDays: 28 }).expect(204);

    await lock(company.id, 2026, 3);
    expect((await agent.post('/api/working-days/2026/3').send({ workingDays: 20 }).expect(409)).body.code).toBe('period.locked');
    expect((await agent.get('/api/working-days?year=2026').expect(200)).body.months[2].locked).toBe(true);
  });
});

describe('tenant isolation', () => {
  it("never shows or changes another company's rules, holidays or working days", async () => {
    const a = await memberOfNewCompany(ctx, 'OWNER');
    const b = await memberOfNewCompany(ctx, 'OWNER');
    await b.agent.put('/api/pay-rules/2026/1').send(RULES).expect(204);
    const { id } = (await b.agent.post('/api/holidays').send({ date: '2026-06-01', kind: 'COMPANY_DAY_OFF' }).expect(201)).body;
    await b.agent.post('/api/working-days/2026/6').send({ workingDays: 20 }).expect(204);

    expect((await a.agent.get('/api/pay-rules').expect(200)).body).toEqual([]);
    expect((await a.agent.get('/api/holidays?year=2026').expect(200)).body.entered).toEqual([]);
    const aJune = (await a.agent.get('/api/working-days?year=2026').expect(200)).body.months[5];
    expect(aJune).toMatchObject({ rulesFrom: null, override: null, history: [] });

    await a.agent.put(`/api/holidays/${id}`).send({ date: '2026-06-03', kind: 'COMPANY_DAY_OFF' }).expect(404);
    await a.agent.delete(`/api/holidays/${id}`).expect(404);
    await a.agent.delete('/api/pay-rules/2026/1').expect(404);
    // A's own changes stay in A.
    await a.agent.put('/api/pay-rules/2026/1').send({ ...RULES, holidayMultiplier: '5' }).expect(204);
    expect((await b.agent.get('/api/pay-rules').expect(200)).body[0].rules.holidayMultiplier).toBe('2');
    expect((await b.agent.get('/api/holidays?year=2026').expect(200)).body.entered).toEqual([
      { id, date: '2026-06-01', kind: 'COMPANY_DAY_OFF', name: null },
    ]);
  });
});
