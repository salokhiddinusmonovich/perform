import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dayToDate, isoDay, todayIn } from '../src/common/dates';
import { firstOfMonth, nextMonth } from '../src/platform/company-plan';
import {
  addMember,
  createPlan,
  createUser,
  givePlan,
  loginAs,
  memberOfNewCompany,
  PASSWORD,
  resetDb,
  startApp,
  type TestContext,
} from './helpers';

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

/** The calendar day `offset` days from today in Tashkent (test companies' zone), "YYYY-MM-DD". */
function day(offset: number) {
  const date = dayToDate(todayIn('Asia/Tashkent'));
  date.setUTCDate(date.getUTCDate() + offset);
  return isoDay(date);
}

/** The month `offset` months from this month in Tashkent. */
function month(offset: number) {
  const date = dayToDate(todayIn('Asia/Tashkent'));
  date.setUTCMonth(date.getUTCMonth() + offset, 1);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

async function platformAdmin() {
  const admin = await createUser(ctx.prisma, { isPlatformAdmin: true });
  return { admin, agent: await loginAs(ctx.app, admin.email!) };
}

function newCompany(planId: string) {
  return {
    name: 'Perform Test MEP',
    currency: 'UZS',
    timezone: 'Asia/Tashkent',
    owner: { fullName: 'Test Owner', phone: '+998901234567', email: '' },
    planId,
    paidThrough: month(1),
  };
}

/** Made-up worker details. */
const WORKER = {
  lastName: 'Testov',
  firstName: 'Test',
  patronymic: '',
  position: 'Electrician',
  employmentType: 'DIRECT',
  pinfl: '',
  birthDate: '',
  nationality: '',
  passportSeries: '',
  passportNumber: '',
  phone: '',
};

describe('platform companies', () => {
  it('is closed to customers, even company owners', async () => {
    const { agent } = await memberOfNewCompany(ctx, 'OWNER');
    const plan = await createPlan(ctx.prisma);
    await agent.get('/api/platform/companies').expect(403);
    await agent.post('/api/platform/companies').send(newCompany(plan.id)).expect(403);
    await agent.get('/api/platform/users').expect(403);
    await agent.get('/api/platform/plans').expect(403);
  });

  it('creates a company on a plan with a new owner who can log in and must set a password', async () => {
    const { agent } = await platformAdmin();
    const plan = await createPlan(ctx.prisma, { maxActiveWorkers: 50 });

    const res = await agent.post('/api/platform/companies').send(newCompany(plan.id)).expect(201);
    expect(res.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{12}$/);

    const owner = await loginAs(ctx.app, '901234567', res.body.temporaryPassword);
    const me = await owner.get('/api/auth/me').expect(200);
    expect(me.body.user.mustChangePassword).toBe(true);
    expect(me.body.activeCompany).toMatchObject({
      id: res.body.companyId,
      name: 'Perform Test MEP',
      role: 'OWNER',
      subscription: { status: 'ACTIVE', planName: plan.name, paidThrough: firstOfMonth(month(1)) },
    });

    const list = await agent.get('/api/platform/companies').expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({
        name: 'Perform Test MEP',
        memberCount: 1,
        owners: [{ fullName: 'Test Owner', email: null, phone: '+998901234567' }],
        plan: { id: plan.id, name: plan.name, maxActiveWorkers: 50, timesheetModule: false },
        subscription: expect.objectContaining({ status: 'ACTIVE' }),
        activeWorkers: 0,
      }),
    ]);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'company.create' } })).toBe(1);
  });

  it('makes an existing user the owner without a new password', async () => {
    const { agent } = await platformAdmin();
    const plan = await createPlan(ctx.prisma);
    const existing = await createUser(ctx.prisma, { phone: '+998901234567' });

    const res = await agent.post('/api/platform/companies').send(newCompany(plan.id)).expect(201);
    expect(res.body).toMatchObject({ ownerUserId: existing.id, temporaryPassword: null });
  });

  it('needs a plan that is offered', async () => {
    const { agent } = await platformAdmin();
    const archived = await createPlan(ctx.prisma, { isActive: false });
    const res = await agent.post('/api/platform/companies').send(newCompany(archived.id)).expect(409);
    expect(res.body.code).toBe('plan.archived');
    const missing = { ...newCompany(archived.id), planId: undefined };
    expect((await agent.post('/api/platform/companies').send(missing).expect(400)).body.issues).toEqual([
      { path: 'planId', message: 'validation.required' },
    ]);
    expect(await ctx.prisma.company.count()).toBe(0);
  });

  it('deactivating a company cuts off its members', async () => {
    const { agent: adminAgent } = await platformAdmin();
    const member = await memberOfNewCompany(ctx, 'OWNER');
    await member.agent.get('/api/company').expect(200);

    await adminAgent.patch(`/api/platform/companies/${member.company.id}`).send({ isActive: false }).expect(204);
    const res = await member.agent.get('/api/company').expect(403);
    expect(res.body.code).toBe('company.required');

    await adminAgent.patch(`/api/platform/companies/${member.company.id}`).send({ isActive: true }).expect(204);
    await member.agent.get('/api/company').expect(200);
  });

  it('edits a company’s settings, with an audit record', async () => {
    const { admin, agent } = await platformAdmin();
    const { company } = await memberOfNewCompany(ctx, 'OWNER');
    await agent.patch(`/api/platform/companies/${company.id}`).send({ name: 'Renamed LLC', currency: 'usd' }).expect(204);
    expect(await ctx.prisma.company.findUniqueOrThrow({ where: { id: company.id } })).toMatchObject({
      name: 'Renamed LLC',
      currency: 'USD',
    });
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'company.update', companyId: company.id } });
    expect(log).toMatchObject({ actorUserId: admin.id, data: { name: { to: 'Renamed LLC' }, currency: { from: 'UZS', to: 'USD' } } });
  });

  it('keeps an archived plan on a company but moves no company onto one', async () => {
    const { agent } = await platformAdmin();
    const { company } = await memberOfNewCompany(ctx, 'OWNER');
    const plan = await createPlan(ctx.prisma);
    await agent.patch(`/api/platform/companies/${company.id}`).send({ planId: plan.id }).expect(204);
    await agent.patch(`/api/platform/plans/${plan.id}`).send({ isActive: false }).expect(204);
    await agent.patch(`/api/platform/companies/${company.id}`).send({ planId: plan.id, name: 'Still fine' }).expect(204);

    const other = await memberOfNewCompany(ctx, 'OWNER');
    const res = await agent.patch(`/api/platform/companies/${other.company.id}`).send({ planId: plan.id }).expect(409);
    expect(res.body.code).toBe('plan.archived');
  });
});

describe('plan changes', () => {
  /** The 1st of next month in Tashkent, "YYYY-MM-01". */
  const nextMonthStart = () => firstOfMonth(nextMonth(day(0)));

  it('start on the 1st of next month; choosing this month’s plan again cancels the change', async () => {
    const { admin, agent } = await platformAdmin();
    const small = await createPlan(ctx.prisma, { maxActiveWorkers: 10 });
    const large = await createPlan(ctx.prisma, { maxActiveWorkers: 50, timesheetModule: true });
    const other = await createPlan(ctx.prisma, { maxActiveWorkers: 20 });
    const company = { id: (await agent.post('/api/platform/companies').send(newCompany(small.id)).expect(201)).body.companyId as string };
    const row = async () => (await agent.get('/api/platform/companies').expect(200)).body.find((c: { id: string }) => c.id === company.id);

    // A new company is on its plan from the 1st of this month.
    expect(await row()).toMatchObject({ plan: { id: small.id }, nextPlan: null });

    await agent.patch(`/api/platform/companies/${company.id}`).send({ planId: large.id }).expect(204);
    expect(await row()).toMatchObject({
      plan: { id: small.id, maxActiveWorkers: 10, timesheetModule: false },
      nextPlan: { id: large.id, maxActiveWorkers: 50, timesheetModule: true, fromMonth: nextMonthStart() },
      subscription: { planName: small.name },
    });
    // Another choice replaces the pending one; this month's plan again cancels it.
    await agent.patch(`/api/platform/companies/${company.id}`).send({ planId: other.id }).expect(204);
    expect((await row()).nextPlan).toMatchObject({ id: other.id });
    await agent.patch(`/api/platform/companies/${company.id}`).send({ planId: small.id }).expect(204);
    expect(await row()).toMatchObject({ plan: { id: small.id }, nextPlan: null });
    await agent.patch(`/api/platform/companies/${company.id}`).send({ planId: small.id }).expect(204);
    expect(await ctx.prisma.companyPlan.count({ where: { companyId: company.id } })).toBe(1);

    const log = await ctx.prisma.auditLog.findMany({ where: { action: 'company.planChange', companyId: company.id }, orderBy: { createdAt: 'asc' } });
    expect(log.map((l) => [l.actorUserId, l.data])).toEqual([
      [admin.id, { from: small.id, to: large.id, fromMonth: nextMonthStart() }],
      [admin.id, { from: large.id, to: other.id, fromMonth: nextMonthStart() }],
      [admin.id, { from: other.id, to: small.id, fromMonth: nextMonthStart() }],
    ]);
  });

  it('gives a company from before plans its first plan from next month too', async () => {
    const { agent } = await platformAdmin();
    const owner = await memberOfNewCompany(ctx, 'OWNER');
    const plan = await createPlan(ctx.prisma, { maxActiveWorkers: 1, timesheetModule: true });
    await agent.patch(`/api/platform/companies/${owner.company.id}`).send({ planId: plan.id }).expect(204);

    const me = (await owner.agent.get('/api/auth/me').expect(200)).body;
    expect(me.activeCompany).toMatchObject({ modules: ['PAYROLL'], subscription: { planName: null } });
    // No limit this month.
    const siteId = (await owner.agent.post('/api/sites').send({ name: 'Site A' }).expect(201)).body.id as string;
    const hire = (from: string) => ({ worker: WORKER, placement: { siteId, teamId: null, from } });
    await owner.agent.post('/api/workers').send(hire(day(0))).expect(201);
    await owner.agent.post('/api/workers').send(hire(day(0))).expect(201);
    // Next month's limit applies to placements starting then.
    const res = await owner.agent.post('/api/workers').send(hire(nextMonthStart())).expect(409);
    expect(res.body).toMatchObject({ code: 'plan.workerLimitReached', limit: 1 });
  });
});

describe('plans', () => {
  it('creates, lists, edits and archives plans, with audit records', async () => {
    const { agent } = await platformAdmin();
    const body = { name: 'Standard', monthlyPrice: '1 500 000', maxActiveWorkers: 100, timesheetModule: true };
    const { id } = (await agent.post('/api/platform/plans').send(body).expect(201)).body;
    expect((await agent.post('/api/platform/plans').send(body).expect(409)).body.code).toBe('plan.nameTaken');

    await agent.patch(`/api/platform/plans/${id}`).send({ monthlyPrice: '1750000', isActive: false }).expect(204);
    const list = (await agent.get('/api/platform/plans').expect(200)).body;
    expect(list).toEqual([
      {
        id,
        name: 'Standard',
        monthlyPrice: '1750000',
        maxActiveWorkers: 100,
        timesheetModule: true,
        isActive: false,
        companyCount: 0,
        inUse: false,
      },
    ]);
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'plan.update', entityId: id } });
    expect(log.data).toEqual({ monthlyPrice: { from: '1500000', to: '1750000' }, isActive: { from: true, to: false } });
  });

  it('fixes a plan’s price, worker limit and modules once a company has had it', async () => {
    const { agent } = await platformAdmin();
    const plan = await createPlan(ctx.prisma);
    const next = await createPlan(ctx.prisma);
    const a = await memberOfNewCompany(ctx, 'OWNER');
    const b = await memberOfNewCompany(ctx, 'OWNER');
    await givePlan(ctx.prisma, a.company.id, plan.id);
    await givePlan(ctx.prisma, b.company.id, plan.id);
    // B moves to another plan from next month: it still counts on both until then.
    await agent.patch(`/api/platform/companies/${b.company.id}`).send({ planId: next.id }).expect(204);
    const list = (await agent.get('/api/platform/plans').expect(200)).body;
    const view = (id: string) => list.find((p: { id: string }) => p.id === id);
    expect(view(plan.id)).toMatchObject({ companyCount: 2, inUse: true });
    expect(view(next.id)).toMatchObject({ companyCount: 1, inUse: true });

    for (const change of [{ monthlyPrice: '2000000' }, { maxActiveWorkers: 5 }, { timesheetModule: true }]) {
      expect((await agent.patch(`/api/platform/plans/${plan.id}`).send(change).expect(409)).body.code).toBe('plan.inUse');
    }
    // The same terms sent again (as the edit form does), a new name and archiving are fine.
    const same = { name: 'Renamed', monthlyPrice: '1 000 000', maxActiveWorkers: 100, timesheetModule: false };
    await agent.patch(`/api/platform/plans/${plan.id}`).send(same).expect(204);
    await agent.patch(`/api/platform/plans/${plan.id}`).send({ isActive: false }).expect(204);
    expect(await ctx.prisma.plan.findUniqueOrThrow({ where: { id: plan.id } })).toMatchObject({ name: 'Renamed', maxActiveWorkers: 100, isActive: false });
  });

  it('refuses a plan without a worker limit', async () => {
    const { agent } = await platformAdmin();
    const res = await agent
      .post('/api/platform/plans')
      .send({ name: 'Free', monthlyPrice: '0', maxActiveWorkers: 0, timesheetModule: false })
      .expect(400);
    expect(res.body.issues).toEqual([{ path: 'maxActiveWorkers', message: 'validation.workerLimitRange' }]);
  });
});

describe('subscriptions', () => {
  async function companyPaidThrough(paidThrough: { year: number; month: number }) {
    const owner = await memberOfNewCompany(ctx, 'OWNER');
    const plan = await createPlan(ctx.prisma);
    await givePlan(ctx.prisma, owner.company.id, plan.id);
    await ctx.prisma.company.update({ where: { id: owner.company.id }, data: { paidThrough: dayToDate(firstOfMonth(paidThrough)) } });
    return owner;
  }

  it('is active through the whole paid month', async () => {
    const { agent } = await companyPaidThrough(month(0));
    const me = (await agent.get('/api/auth/me').expect(200)).body;
    const end = dayToDate(firstOfMonth(month(1)));
    end.setUTCDate(14);
    expect(me.activeCompany.subscription).toMatchObject({
      status: 'ACTIVE',
      paidThrough: firstOfMonth(month(0)),
      graceEndsOn: isoDay(end),
    });
    await agent.patch('/api/company').send({ name: 'Still Working', currency: 'UZS', timezone: 'Asia/Tashkent' }).expect(204);
  });

  it('is read-only after the grace period until a payment is recorded', async () => {
    // Grace ended on the 14th of last month.
    const { company, agent } = await companyPaidThrough(month(-2));
    const settings = { name: 'Changed', currency: 'UZS', timezone: 'Asia/Tashkent' };
    expect((await agent.get('/api/auth/me').expect(200)).body.activeCompany.subscription.status).toBe('READ_ONLY');
    await agent.get('/api/company').expect(200);
    await agent.get('/api/sites').expect(200);
    expect((await agent.patch('/api/company').send(settings).expect(403)).body.code).toBe('subscription.expired');
    expect((await agent.post('/api/sites').send({ name: 'Site A' }).expect(403)).body.code).toBe('subscription.expired');

    const { admin, agent: platform } = await platformAdmin();
    const payment = { amount: '1 000 000', paidOn: day(0), paidThrough: month(1), note: 'Invoice 12' };
    await platform.post(`/api/platform/companies/${company.id}/payments`).send(payment).expect(201);
    await agent.patch('/api/company').send(settings).expect(204);

    const payments = (await platform.get(`/api/platform/companies/${company.id}/payments`).expect(200)).body;
    expect(payments).toEqual([
      expect.objectContaining({ amount: '1000000', paidOn: day(0), paidThrough: firstOfMonth(month(1)), note: 'Invoice 12', recordedBy: admin.fullName }),
    ]);
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'company.payment', companyId: company.id } });
    expect(log.data).toMatchObject({
      amount: '1000000',
      paidThrough: firstOfMonth(month(1)),
      previousPaidThrough: firstOfMonth(month(-2)),
    });
  });

  it('never expires a company not paid through any month (from before plans)', async () => {
    const { agent } = await memberOfNewCompany(ctx, 'OWNER');
    const me = (await agent.get('/api/auth/me').expect(200)).body;
    expect(me.activeCompany.subscription).toEqual({ status: 'NONE', planName: null, paidThrough: null, graceEndsOn: null });
    expect(me.activeCompany.modules).toEqual(['PAYROLL']);
  });

  it('refuses a payment for a company that does not exist', async () => {
    const { agent } = await platformAdmin();
    const payment = { amount: '0', paidOn: day(0), paidThrough: month(1) };
    const res = await agent.post('/api/platform/companies/00000000-0000-4000-8000-000000000000/payments').send(payment);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('company.notFound');
  });
});

describe('worker limit', () => {
  async function companyWithLimit(maxActiveWorkers: number) {
    const owner = await memberOfNewCompany(ctx, 'OWNER');
    const plan = await createPlan(ctx.prisma, { maxActiveWorkers });
    await givePlan(ctx.prisma, owner.company.id, plan.id);
    await ctx.prisma.company.update({ where: { id: owner.company.id }, data: { paidThrough: dayToDate(firstOfMonth(month(1))) } });
    const siteA = (await owner.agent.post('/api/sites').send({ name: 'Site A' }).expect(201)).body.id as string;
    const siteB = (await owner.agent.post('/api/sites').send({ name: 'Site B' }).expect(201)).body.id as string;
    return { ...owner, plan, siteA, siteB };
  }
  const hire = (siteId: string, from = day(0)) => ({
    worker: WORKER,
    placement: { siteId, teamId: null, from },
  });

  it('refuses a worker beyond the plan’s limit of active workers', async () => {
    const { agent, siteA } = await companyWithLimit(1);
    await agent.post('/api/workers').send(hire(siteA)).expect(201);
    const res = await agent.post('/api/workers').send(hire(siteA)).expect(409);
    expect(res.body).toMatchObject({ code: 'plan.workerLimitReached', limit: 1 });
    expect(await ctx.prisma.worker.count()).toBe(1);
  });

  it('never blocks existing workers, even over the limit after a smaller plan', async () => {
    const { agent, siteA, siteB, plan } = await companyWithLimit(2);
    const first = (await agent.post('/api/workers').send(hire(siteA)).expect(201)).body.id as string;
    await agent.post('/api/workers').send(hire(siteA)).expect(201);
    await ctx.prisma.plan.update({ where: { id: plan.id }, data: { maxActiveWorkers: 1 } });

    await agent.post(`/api/workers/${first}/placements`).send({ siteId: siteB, teamId: null, from: day(1) }).expect(204);
    expect((await agent.post('/api/workers').send(hire(siteA)).expect(409)).body.code).toBe('plan.workerLimitReached');
  });

  it('counts active workers for the platform admin', async () => {
    const { agent, siteA } = await companyWithLimit(5);
    await agent.post('/api/workers').send(hire(siteA)).expect(201);
    const { agent: platform } = await platformAdmin();
    const list = (await platform.get('/api/platform/companies').expect(200)).body;
    expect(list[0]).toMatchObject({ activeWorkers: 1, plan: { maxActiveWorkers: 5 } });
  });
});

describe('platform users', () => {
  it('lists every account with its companies', async () => {
    const { agent } = await platformAdmin();
    const { user, company } = await memberOfNewCompany(ctx, 'ACCOUNTANT');
    const list = (await agent.get('/api/platform/users').expect(200)).body;
    expect(list).toHaveLength(2);
    expect(list.find((u: { id: string }) => u.id === user.id)).toMatchObject({
      email: user.email,
      isActive: true,
      isPlatformAdmin: false,
      memberships: [{ companyId: company.id, companyName: company.name, role: 'ACCOUNTANT', isActive: true, invitation: null }],
    });
  });

  it('creates an account that logs in with a temporary password', async () => {
    const { agent } = await platformAdmin();
    const res = await agent
      .post('/api/platform/users')
      .send({ fullName: 'New Operator', email: 'ops@test.local', phone: '', isPlatformAdmin: true })
      .expect(201);
    const ops = await loginAs(ctx.app, 'ops@test.local', res.body.temporaryPassword);
    expect((await ops.get('/api/auth/me').expect(200)).body.user).toMatchObject({ isPlatformAdmin: true, mustChangePassword: true });

    const again = await agent.post('/api/platform/users').send({ fullName: 'Copy', email: 'OPS@test.local', isPlatformAdmin: false });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('user.contactTaken');
  });

  it('edits name and logins, with an audit record', async () => {
    const { admin, agent } = await platformAdmin();
    const user = await createUser(ctx.prisma);
    const taken = await createUser(ctx.prisma, { phone: '+998901112233' });
    const contact = { fullName: 'Renamed Person', email: 'renamed@test.local', phone: '' };
    await agent.patch(`/api/platform/users/${user.id}`).send({ contact }).expect(204);
    expect(await ctx.prisma.user.findUniqueOrThrow({ where: { id: user.id } })).toMatchObject({
      fullName: 'Renamed Person',
      email: 'renamed@test.local',
      phone: null,
    });
    await loginAs(ctx.app, 'renamed@test.local');
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'user.update', entityId: user.id } });
    expect(log).toMatchObject({ actorUserId: admin.id, data: { fullName: { to: 'Renamed Person' } } });

    const clash = await agent.patch(`/api/platform/users/${user.id}`).send({ contact: { ...contact, phone: taken.phone } });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('user.contactTaken');
  });

  it('deactivates an account, signing it out everywhere', async () => {
    const { agent } = await platformAdmin();
    const member = await memberOfNewCompany(ctx, 'OWNER');
    await agent.patch(`/api/platform/users/${member.user.id}`).send({ isActive: false }).expect(204);
    await member.agent.get('/api/company').expect(401);
    expect(await ctx.prisma.session.count({ where: { userId: member.user.id } })).toBe(0);
  });

  it('never lets a platform admin deactivate themselves or drop their own flag', async () => {
    const { admin, agent } = await platformAdmin();
    for (const change of [{ isActive: false }, { isPlatformAdmin: false }]) {
      const res = await agent.patch(`/api/platform/users/${admin.id}`).send(change).expect(403);
      expect(res.body.code).toBe('platform.cannotChangeSelf');
    }
    await agent.post(`/api/platform/users/${admin.id}/reset-password`).expect(403);
  });

  it('resets a password, signing the person out', async () => {
    const { agent } = await platformAdmin();
    const member = await memberOfNewCompany(ctx, 'OWNER');
    const { temporaryPassword } = (await agent.post(`/api/platform/users/${member.user.id}/reset-password`).expect(201)).body;
    await member.agent.get('/api/company').expect(401);
    const again = await loginAs(ctx.app, member.user.email!, temporaryPassword);
    expect((await again.get('/api/auth/me').expect(200)).body.user.mustChangePassword).toBe(true);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'user.passwordReset', entityId: member.user.id } })).toBe(1);
  });

  it('puts a person in a company and changes their role there, keeping the last owner', async () => {
    const { agent } = await platformAdmin();
    const owner = await memberOfNewCompany(ctx, 'OWNER');
    const person = await createUser(ctx.prisma);
    const url = `/api/platform/users/${person.id}/memberships/${owner.company.id}`;

    await agent.put(url).send({ role: 'ACCOUNTANT', isActive: true }).expect(204);
    const personAgent = await loginAs(ctx.app, person.email!);
    expect((await personAgent.get('/api/auth/me').expect(200)).body.activeCompany).toMatchObject({ role: 'ACCOUNTANT' });

    await agent.put(url).send({ role: 'ADMIN', isActive: true }).expect(204);
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'member.update', entityId: person.id } });
    expect(log.data).toMatchObject({ role: { from: 'ACCOUNTANT', to: 'ADMIN' } });

    const ownerUrl = `/api/platform/users/${owner.user.id}/memberships/${owner.company.id}`;
    expect((await agent.put(ownerUrl).send({ role: 'ADMIN', isActive: true }).expect(400)).body.code).toBe('member.lastOwner');
  });

  it('accepts an open invitation when the platform admin puts the person in', async () => {
    const { agent } = await platformAdmin();
    const owner = await memberOfNewCompany(ctx, 'OWNER');
    const person = await createUser(ctx.prisma);
    await ctx.prisma.membership.create({ data: { userId: person.id, companyId: owner.company.id, role: 'FOREMAN' } });
    await agent.put(`/api/platform/users/${person.id}/memberships/${owner.company.id}`).send({ role: 'TIMEKEEPER', isActive: true }).expect(204);
    const membership = await ctx.prisma.membership.findFirstOrThrow({ where: { userId: person.id } });
    expect(membership).toMatchObject({ role: 'TIMEKEEPER', acceptedAt: expect.any(Date) });
  });
});

describe('impersonation', () => {
  it('acts as the user, audited under both names, until the admin ends it', async () => {
    const { admin, agent } = await platformAdmin();
    const member = await memberOfNewCompany(ctx, 'OWNER');

    await agent.post(`/api/platform/users/${member.user.id}/impersonate`).expect(201);
    const me = (await agent.get('/api/auth/me').expect(200)).body;
    expect(me.user.id).toBe(member.user.id);
    expect(me.activeCompany.id).toBe(member.company.id);
    expect(me.impersonation).toEqual({ by: admin.fullName, endsAt: expect.any(String) });
    expect(new Date(me.impersonation.endsAt).getTime() - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000);

    await agent.post('/api/sites').send({ name: 'Site A' }).expect(201);
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'site.create' } });
    expect(log).toMatchObject({ actorUserId: member.user.id, impersonatorUserId: admin.id, companyId: member.company.id });

    // Acting as a customer, the admin has no platform access.
    await agent.get('/api/platform/users').expect(403);

    await agent.post('/api/auth/impersonation/end').expect(204);
    const after = (await agent.get('/api/auth/me').expect(200)).body;
    expect(after).toMatchObject({ user: { id: admin.id }, impersonation: null });
    await agent.get('/api/platform/users').expect(200);
    expect(await ctx.prisma.auditLog.count({ where: { action: { in: ['impersonation.start', 'impersonation.end'] } } })).toBe(2);

    // The user's own session was never touched.
    await member.agent.get('/api/company').expect(200);
  });

  it('leaves the password, sessions and invitations to the real person', async () => {
    const { agent } = await platformAdmin();
    const member = await memberOfNewCompany(ctx, 'OWNER');
    await agent.post(`/api/platform/users/${member.user.id}/impersonate`).expect(201);

    const change = { currentPassword: PASSWORD, newPassword: 'another-long-password' };
    expect((await agent.post('/api/auth/change-password').send(change).expect(403)).body.code).toBe('impersonation.notAllowed');
    expect((await agent.get('/api/auth/sessions').expect(403)).body.code).toBe('impersonation.notAllowed');
    const invite = await agent.post(`/api/invitations/${member.company.id}/accept`).expect(403);
    expect(invite.body.code).toBe('impersonation.notAllowed');
  });

  it('works for a user who still has a temporary password', async () => {
    const { agent } = await platformAdmin();
    const member = await memberOfNewCompany(ctx, 'OWNER');
    await ctx.prisma.user.update({ where: { id: member.user.id }, data: { mustChangePassword: true } });
    await agent.post(`/api/platform/users/${member.user.id}/impersonate`).expect(201);
    await agent.get('/api/company').expect(200);
  });

  it('ends by itself after the hour', async () => {
    const { admin, agent } = await platformAdmin();
    const member = await memberOfNewCompany(ctx, 'OWNER');
    await agent.post(`/api/platform/users/${member.user.id}/impersonate`).expect(201);
    await ctx.prisma.session.updateMany({ where: { userId: admin.id }, data: { impersonationEndsAt: new Date(Date.now() - 1000) } });

    expect((await agent.get('/api/auth/me').expect(200)).body).toMatchObject({ user: { id: admin.id }, impersonation: null });
    expect((await ctx.prisma.session.findFirstOrThrow({ where: { userId: admin.id } })).impersonatedUserId).toBeNull();
  });

  it('ends when the user is deactivated', async () => {
    const { admin, agent } = await platformAdmin();
    const member = await memberOfNewCompany(ctx, 'OWNER');
    await agent.post(`/api/platform/users/${member.user.id}/impersonate`).expect(201);
    await ctx.prisma.user.update({ where: { id: member.user.id }, data: { isActive: false } });
    expect((await agent.get('/api/auth/me').expect(200)).body.user.id).toBe(admin.id);
  });

  it('is not for platform admins, deactivated accounts, or customers', async () => {
    const { agent } = await platformAdmin();
    const other = await createUser(ctx.prisma, { isPlatformAdmin: true });
    const inactive = await createUser(ctx.prisma, { isActive: false });
    expect((await agent.post(`/api/platform/users/${other.id}/impersonate`).expect(403)).body.code).toBe('impersonation.platformAdmin');
    expect((await agent.post(`/api/platform/users/${inactive.id}/impersonate`).expect(409)).body.code).toBe('impersonation.inactiveUser');

    const owner = await memberOfNewCompany(ctx, 'OWNER');
    const person = await createUser(ctx.prisma);
    await addMember(ctx.prisma, person.id, owner.company.id, 'ACCOUNTANT');
    await owner.agent.post(`/api/platform/users/${person.id}/impersonate`).expect(403);
    expect((await owner.agent.post('/api/auth/impersonation/end').expect(409)).body.code).toBe('impersonation.notActive');
  });
});
