import { Controller, Get, Post } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ForModule, Roles } from '../src/auth/auth.context';
import { addMember, createPlan, createUser, loginAs, memberOfNewCompany, PASSWORD, resetDb, startApp, type TestContext } from './helpers';

/** Test-only routes: one per module, and one that forgot to declare its module. */
@Controller('test-probe')
class ProbeController {
  @ForModule('TIMESHEET')
  @Roles('OWNER')
  @Get('timesheet')
  timesheet() {
    return { ok: true };
  }

  @ForModule('PAYROLL')
  @Roles('OWNER')
  @Post('payroll')
  payroll() {
    return { ok: true };
  }

  @Roles('OWNER')
  @Get('undeclared')
  undeclared() {
    return { ok: true };
  }
}

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp([ProbeController])));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

const http = () => request(ctx.app.getHttpServer());

async function appToken(identifier: string, deviceName = 'Foreman phone') {
  const res = await http().post('/api/auth/token').send({ identifier, password: PASSWORD, deviceName }).expect(201);
  return res.body.token as string;
}

describe('app sessions (bearer tokens)', () => {
  it('logs the app in with a token that works as a bearer header', async () => {
    const { user, company } = await memberOfNewCompany(ctx, 'OWNER');
    const token = await appToken(user.email!);
    const me = await http().get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(200);
    expect(me.body.activeCompany).toMatchObject({ id: company.id, role: 'OWNER', modules: ['PAYROLL'] });

    const session = await ctx.prisma.session.findFirstOrThrow({ where: { userId: user.id, kind: 'APP' } });
    expect(session.deviceName).toBe('Foreman phone');
    expect(session.tokenHash).not.toContain(token);
  });

  it('accepts a token only the way it was issued', async () => {
    const { user } = await memberOfNewCompany(ctx, 'OWNER');
    const token = await appToken(user.email!);
    // An app token in a cookie is not a session.
    const asCookie = await http().get('/api/auth/me').set('Cookie', `sid=${token}`).expect(200);
    expect(asCookie.text).toBe('');

    // A browser cookie token sent as a bearer header isn't either.
    const login = await http().post('/api/auth/login').send({ identifier: user.email, password: PASSWORD }).expect(204);
    const cookieToken = /sid=([^;]+)/.exec(String(login.headers['set-cookie']))![1];
    const asBearer = await http().get('/api/auth/me').set('Authorization', `Bearer ${cookieToken}`).expect(200);
    expect(asBearer.text).toBe('');
  });

  it('skips the same-site check for bearer requests but not for cookies', async () => {
    const { user, agent } = await memberOfNewCompany(ctx, 'OWNER');
    const token = await appToken(user.email!);
    await http()
      .post('/api/test-probe/payroll')
      .set('Authorization', `Bearer ${token}`)
      .set('Origin', 'https://elsewhere.example')
      .expect(201);
    const blocked = await agent.post('/api/test-probe/payroll').set('Origin', 'https://elsewhere.example').expect(403);
    expect(blocked.body.code).toBe('auth.crossSite');
  });

  it('lists the user’s own sessions and revokes one, e.g. a lost phone', async () => {
    const { user, agent } = await memberOfNewCompany(ctx, 'OWNER');
    const token = await appToken(user.email!, 'Lost phone');
    const list = (await agent.get('/api/auth/sessions').expect(200)).body;
    expect(list).toHaveLength(2);
    const phone = list.find((s: { kind: string }) => s.kind === 'APP');
    expect(phone).toMatchObject({ deviceName: 'Lost phone', current: false });
    expect(list.find((s: { kind: string }) => s.kind === 'BROWSER')).toMatchObject({ current: true });

    await agent.delete(`/api/auth/sessions/${phone.id}`).expect(204);
    expect((await http().get('/api/auth/me').set('Authorization', `Bearer ${token}`).expect(200)).text).toBe('');
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'auth.sessionRevoked' } });
    expect(log.entityId).toBe(phone.id);
  });

  it("can't revoke someone else's session", async () => {
    const a = await memberOfNewCompany(ctx, 'OWNER');
    const b = await memberOfNewCompany(ctx, 'OWNER');
    await appToken(b.user.email!);
    const bSession = await ctx.prisma.session.findFirstOrThrow({ where: { userId: b.user.id, kind: 'APP' } });
    expect((await a.agent.delete(`/api/auth/sessions/${bSession.id}`).expect(404)).body.code).toBe('session.notFound');
    expect(await ctx.prisma.session.count({ where: { id: bSession.id } })).toBe(1);
  });

  it('requires a device name', async () => {
    const { user } = await memberOfNewCompany(ctx, 'OWNER');
    const res = await http().post('/api/auth/token').send({ identifier: user.email, password: PASSWORD }).expect(400);
    expect(res.body.issues).toEqual([{ path: 'deviceName', message: 'validation.required' }]);
  });
});

describe('modules', () => {
  it('refuses routes of a module the company does not have', async () => {
    const { company, agent } = await memberOfNewCompany(ctx, 'OWNER');
    const off = await agent.get('/api/test-probe/timesheet').expect(403);
    expect(off.body.code).toBe('module.disabled');

    const plan = await createPlan(ctx.prisma, { timesheetModule: true });
    await ctx.prisma.company.update({ where: { id: company.id }, data: { planId: plan.id } });
    await agent.get('/api/test-probe/timesheet').expect(200);
    expect((await agent.get('/api/auth/me').expect(200)).body.activeCompany.modules).toEqual(['PAYROLL', 'TIMESHEET']);
  });

  it('fails loudly for a company route that declares no module', async () => {
    const { agent } = await memberOfNewCompany(ctx, 'OWNER');
    await agent.get('/api/test-probe/undeclared').expect(500);
  });

  it('takes modules from the plan, which only the platform admin assigns, with an audit record', async () => {
    const owner = await memberOfNewCompany(ctx, 'OWNER');
    const plan = await createPlan(ctx.prisma, { timesheetModule: true });
    await owner.agent.patch(`/api/platform/companies/${owner.company.id}`).send({ planId: plan.id }).expect(403);

    const admin = await createUser(ctx.prisma, { isPlatformAdmin: true });
    const platform = await loginAs(ctx.app, admin.email!);
    await platform.patch(`/api/platform/companies/${owner.company.id}`).send({ planId: plan.id }).expect(204);
    await owner.agent.get('/api/test-probe/timesheet').expect(200);
    const list = (await platform.get('/api/platform/companies').expect(200)).body;
    expect(list[0]).toMatchObject({ plan: { id: plan.id, timesheetModule: true }, isActive: true });
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'company.planChange', companyId: owner.company.id } });
    expect(log).toMatchObject({ actorUserId: admin.id, data: { from: null, to: plan.id } });
  });
});

describe('roles', () => {
  it('has a project manager role, and a new role starts without the old site or team assignments', async () => {
    const { company, agent } = await memberOfNewCompany(ctx, 'OWNER');
    const site = await ctx.prisma.site.create({ data: { companyId: company.id, name: 'Site A' } });
    const person = await createUser(ctx.prisma);
    await addMember(ctx.prisma, person.id, company.id, 'TIMEKEEPER');
    await ctx.prisma.memberSite.create({ data: { userId: person.id, companyId: company.id, siteId: site.id } });

    await agent.patch(`/api/company/members/${person.id}`).send({ role: 'PROJECT_MANAGER' }).expect(204);
    expect(await ctx.prisma.memberSite.count({ where: { userId: person.id } })).toBe(0);
    const log = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'member.update', entityId: person.id } });
    expect(log.data).toMatchObject({ role: { from: 'TIMEKEEPER', to: 'PROJECT_MANAGER' }, clearedScopes: { siteIds: [site.id] } });
  });
});
