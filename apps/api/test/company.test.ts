import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  createCompany,
  createUser,
  loginAs,
  memberOfNewCompany,
  resetDb,
  startApp,
  type TestContext,
} from './helpers';

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

describe('company settings', () => {
  it('lets owners and admins read and update settings, with an audit record', async () => {
    const { company, user, agent } = await memberOfNewCompany(ctx, 'ADMIN');
    await agent.patch('/api/company').send({ name: 'Renamed MEP', currency: 'usd', timezone: 'Asia/Tashkent' }).expect(204);

    const res = await agent.get('/api/company').expect(200);
    expect(res.body).toEqual({ name: 'Renamed MEP', currency: 'USD', timezone: 'Asia/Tashkent' });

    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'company.update', companyId: company.id } });
    expect(log.actorUserId).toBe(user.id);
    expect(log.data).toMatchObject({ currency: { from: 'UZS', to: 'USD' } });
  });

  it('forbids other roles', async () => {
    for (const role of ['ACCOUNTANT', 'TIMEKEEPER', 'FOREMAN'] as const) {
      const { agent } = await memberOfNewCompany(ctx, role);
      await agent.get('/api/company').expect(403);
      await agent.get('/api/company/members').expect(403);
    }
  });
});

describe('tenant isolation', () => {
  it("never shows or changes another company's members", async () => {
    const a = await memberOfNewCompany(ctx, 'OWNER');
    const b = await memberOfNewCompany(ctx, 'OWNER');
    const bWorker = await createUser(ctx.prisma);
    await addMember(ctx.prisma, bWorker.id, b.company.id, 'FOREMAN');

    const list = await a.agent.get('/api/company/members').expect(200);
    expect(list.body.map((m: { userId: string }) => m.userId)).toEqual([a.user.id]);

    await a.agent.patch(`/api/company/members/${bWorker.id}`).send({ role: 'ADMIN' }).expect(404);
    await a.agent.post(`/api/company/members/${bWorker.id}/reset-password`).expect(404);
    const unchanged = await ctx.prisma.membership.findUniqueOrThrow({
      where: { userId_companyId: { userId: bWorker.id, companyId: b.company.id } },
    });
    expect(unchanged.role).toBe('FOREMAN');
  });

  it('ignores a companyId sent by the client', async () => {
    const a = await memberOfNewCompany(ctx, 'OWNER');
    const b = await memberOfNewCompany(ctx, 'OWNER');
    await a.agent
      .post('/api/company/members')
      .send({ fullName: 'Sneaky Add', phone: '+998901112233', role: 'FOREMAN', companyId: b.company.id })
      .expect(201);
    expect(await ctx.prisma.membership.count({ where: { companyId: b.company.id } })).toBe(1);
  });
});

describe('adding members', () => {
  it('creates a new account with a one-time temporary password', async () => {
    const { company, agent } = await memberOfNewCompany(ctx, 'OWNER');
    const res = await agent
      .post('/api/company/members')
      .send({ fullName: 'New Foreman', phone: '90 765 43 21', email: '', role: 'FOREMAN' })
      .expect(201);
    expect(res.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{12}$/);

    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { phone: '+998907654321' } });
    expect(user.mustChangePassword).toBe(true);
    expect(user.passwordHash).not.toContain(res.body.temporaryPassword);

    const foreman = await loginAs(ctx.app, '+998907654321', res.body.temporaryPassword);
    const me = await foreman.get('/api/auth/me').expect(200);
    expect(me.body.activeCompany).toMatchObject({ id: company.id, role: 'FOREMAN' });
  });

  it('reuses an existing account without revealing or changing its password', async () => {
    const other = await memberOfNewCompany(ctx, 'OWNER');
    const { agent } = await memberOfNewCompany(ctx, 'OWNER');
    const res = await agent
      .post('/api/company/members')
      .send({ fullName: 'Different Name', email: other.user.email, role: 'ACCOUNTANT' })
      .expect(201);
    expect(res.body).toEqual({ userId: other.user.id, temporaryPassword: null });
    const user = await ctx.prisma.user.findUniqueOrThrow({ where: { id: other.user.id } });
    expect(user.fullName).toBe(other.user.fullName);
  });

  it('refuses a duplicate member and contacts that belong to two different people', async () => {
    const { agent, user } = await memberOfNewCompany(ctx, 'OWNER');
    const dup = await agent.post('/api/company/members').send({ fullName: 'Me Again', email: user.email, role: 'ADMIN' }).expect(409);
    expect(dup.body.code).toBe('member.alreadyExists');

    await createUser(ctx.prisma, { email: 'one@test.local' });
    await createUser(ctx.prisma, { phone: '+998935554433' });
    const mixed = await agent
      .post('/api/company/members')
      .send({ fullName: 'Mixed Up', email: 'one@test.local', phone: '+998935554433', role: 'FOREMAN' })
      .expect(409);
    expect(mixed.body.code).toBe('user.contactsBelongToDifferentPeople');
  });

  it('returns per-field validation errors', async () => {
    const { agent } = await memberOfNewCompany(ctx, 'OWNER');
    const res = await agent.post('/api/company/members').send({ fullName: 'X', phone: '123', role: 'FOREMAN' }).expect(400);
    expect(res.body.issues).toEqual(
      expect.arrayContaining([
        { path: 'fullName', message: 'validation.nameTooShort' },
        { path: 'phone', message: 'validation.phoneInvalid' },
      ]),
    );
  });
});

describe('owner rules', () => {
  it('lets only owners grant or change the owner role', async () => {
    const { company, agent } = await memberOfNewCompany(ctx, 'ADMIN');
    const owner = await createUser(ctx.prisma);
    await addMember(ctx.prisma, owner.id, company.id, 'OWNER');

    const grant = await agent.post('/api/company/members').send({ fullName: 'Would Be Owner', phone: '+998901110000', role: 'OWNER' }).expect(403);
    expect(grant.body.code).toBe('member.onlyOwnerManagesOwners');
    await agent.patch(`/api/company/members/${owner.id}`).send({ isActive: false }).expect(403);
  });

  it('lets an owner demote or deactivate another owner, so the acting owner always remains', async () => {
    const { company, user, agent } = await memberOfNewCompany(ctx, 'OWNER');
    const coOwner = await createUser(ctx.prisma);
    await addMember(ctx.prisma, coOwner.id, company.id, 'OWNER');

    await agent.patch(`/api/company/members/${coOwner.id}`).send({ role: 'ADMIN' }).expect(204);
    await agent.patch(`/api/company/members/${coOwner.id}`).send({ isActive: false }).expect(204);

    // Only the caller remains an active owner; they can't remove themselves (tested below),
    // so a company can't end up without an owner through the API.
    const owners = await ctx.prisma.membership.findMany({ where: { companyId: company.id, role: 'OWNER', isActive: true } });
    expect(owners.map((o) => o.userId)).toEqual([user.id]);
  });

  it('does not let anyone change their own role or status', async () => {
    const { user, agent } = await memberOfNewCompany(ctx, 'OWNER');
    const res = await agent.patch(`/api/company/members/${user.id}`).send({ isActive: false }).expect(403);
    expect(res.body.code).toBe('member.cannotChangeSelf');
  });
});

describe('deactivating and password resets', () => {
  it('cuts off a deactivated member immediately', async () => {
    const { company, agent } = await memberOfNewCompany(ctx, 'OWNER');
    const worker = await createUser(ctx.prisma);
    await addMember(ctx.prisma, worker.id, company.id, 'ADMIN');
    const workerAgent = await loginAs(ctx.app, worker.email!);
    await workerAgent.get('/api/company').expect(200);

    await agent.patch(`/api/company/members/${worker.id}`).send({ isActive: false }).expect(204);
    const res = await workerAgent.get('/api/company').expect(403);
    expect(res.body.code).toBe('company.required');
  });

  it('resets the password of an account that belongs only to this company', async () => {
    const { company, agent } = await memberOfNewCompany(ctx, 'OWNER');
    const worker = await createUser(ctx.prisma);
    await addMember(ctx.prisma, worker.id, company.id, 'FOREMAN');
    const oldSession = await loginAs(ctx.app, worker.email!);

    const res = await agent.post(`/api/company/members/${worker.id}/reset-password`).expect(201);
    await oldSession.get('/api/company').expect(401);
    const fresh = await loginAs(ctx.app, worker.email!, res.body.temporaryPassword);
    const me = await fresh.get('/api/auth/me').expect(200);
    expect(me.body.user.mustChangePassword).toBe(true);
  });

  it("refuses to reset an account that also belongs to another company", async () => {
    const a = await memberOfNewCompany(ctx, 'OWNER');
    const b = await memberOfNewCompany(ctx, 'OWNER');
    const shared = await createUser(ctx.prisma);
    await addMember(ctx.prisma, shared.id, a.company.id, 'FOREMAN');
    await addMember(ctx.prisma, shared.id, b.company.id, 'ACCOUNTANT');

    const res = await a.agent.post(`/api/company/members/${shared.id}/reset-password`).expect(403);
    expect(res.body.code).toBe('member.sharedAccount');
  });
});
