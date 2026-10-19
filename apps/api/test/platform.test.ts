import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, loginAs, memberOfNewCompany, resetDb, startApp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

const newCompany = {
  name: 'Perform Test MEP',
  currency: 'UZS',
  timezone: 'Asia/Tashkent',
  owner: { fullName: 'Test Owner', phone: '+998901234567', email: '' },
};

describe('platform companies', () => {
  it('is closed to customers, even company owners', async () => {
    const { agent } = await memberOfNewCompany(ctx, 'OWNER');
    await agent.get('/api/platform/companies').expect(403);
    await agent.post('/api/platform/companies').send(newCompany).expect(403);
  });

  it('creates a company with a new owner who can log in and must set a password', async () => {
    const admin = await createUser(ctx.prisma, { isPlatformAdmin: true });
    const agent = await loginAs(ctx.app, admin.email!);

    const res = await agent.post('/api/platform/companies').send(newCompany).expect(201);
    expect(res.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{12}$/);

    const owner = await loginAs(ctx.app, '901234567', res.body.temporaryPassword);
    const me = await owner.get('/api/auth/me').expect(200);
    expect(me.body.user.mustChangePassword).toBe(true);
    expect(me.body.activeCompany).toMatchObject({ id: res.body.companyId, name: 'Perform Test MEP', role: 'OWNER' });

    const list = await agent.get('/api/platform/companies').expect(200);
    expect(list.body).toEqual([
      expect.objectContaining({
        name: 'Perform Test MEP',
        memberCount: 1,
        owners: [{ fullName: 'Test Owner', email: null, phone: '+998901234567' }],
      }),
    ]);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'company.create' } })).toBe(1);
  });

  it('makes an existing user the owner without a new password', async () => {
    const admin = await createUser(ctx.prisma, { isPlatformAdmin: true });
    const existing = await createUser(ctx.prisma, { phone: '+998901234567' });
    const agent = await loginAs(ctx.app, admin.email!);

    const res = await agent.post('/api/platform/companies').send(newCompany).expect(201);
    expect(res.body).toMatchObject({ ownerUserId: existing.id, temporaryPassword: null });
  });

  it('deactivating a company cuts off its members', async () => {
    const admin = await createUser(ctx.prisma, { isPlatformAdmin: true });
    const adminAgent = await loginAs(ctx.app, admin.email!);
    const member = await memberOfNewCompany(ctx, 'OWNER');
    await member.agent.get('/api/company').expect(200);

    await adminAgent.patch(`/api/platform/companies/${member.company.id}`).send({ isActive: false }).expect(204);
    const res = await member.agent.get('/api/company').expect(403);
    expect(res.body.code).toBe('company.required');

    await adminAgent.patch(`/api/platform/companies/${member.company.id}`).send({ isActive: true }).expect(204);
    await member.agent.get('/api/company').expect(200);
  });
});
