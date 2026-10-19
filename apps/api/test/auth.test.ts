import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  createCompany,
  createUser,
  loginAs,
  PASSWORD,
  resetDb,
  startApp,
  type TestContext,
} from './helpers';

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

const http = () => request(ctx.app.getHttpServer());

describe('login', () => {
  it('logs in with email and returns the user and company from /me', async () => {
    const company = await createCompany(ctx.prisma, 'Test MEP');
    const user = await createUser(ctx.prisma, { email: 'boss@test.local' });
    await addMember(ctx.prisma, user.id, company.id, 'OWNER');

    const agent = await loginAs(ctx.app, 'Boss@Test.Local');
    const me = await agent.get('/api/auth/me').expect(200);

    expect(me.body.user).toMatchObject({ id: user.id, email: 'boss@test.local', mustChangePassword: false });
    expect(me.body.user).not.toHaveProperty('passwordHash');
    expect(me.body.activeCompany).toMatchObject({ id: company.id, name: 'Test MEP', role: 'OWNER' });
    expect(me.body.companies).toEqual([{ id: company.id, name: 'Test MEP', role: 'OWNER' }]);
  });

  it('logs in with a phone number written differently than stored', async () => {
    await createUser(ctx.prisma, { phone: '+998901234567' });
    await loginAs(ctx.app, '90 123-45-67');
  });

  it('sets an httpOnly, SameSite=Lax session cookie', async () => {
    await createUser(ctx.prisma, { email: 'c@test.local' });
    const res = await http().post('/api/auth/login').send({ identifier: 'c@test.local', password: PASSWORD }).expect(204);
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Lax/);
  });

  it('gives the same answer for a wrong password, an unknown login and a disabled account', async () => {
    await createUser(ctx.prisma, { email: 'a@test.local' });
    await createUser(ctx.prisma, { email: 'off@test.local', isActive: false });

    for (const body of [
      { identifier: 'a@test.local', password: 'wrong-password' },
      { identifier: 'nobody@test.local', password: PASSWORD },
      { identifier: 'off@test.local', password: PASSWORD },
    ]) {
      const res = await http().post('/api/auth/login').send(body).expect(401);
      expect(res.body.code).toBe('auth.invalidCredentials');
    }
  });

  it('blocks a login name after 5 failed attempts, even with the right password', async () => {
    await createUser(ctx.prisma, { email: 'target@test.local' });
    for (let i = 0; i < 5; i++) {
      await http().post('/api/auth/login').send({ identifier: 'target@test.local', password: 'guess' }).expect(401);
    }
    const res = await http()
      .post('/api/auth/login')
      .send({ identifier: 'target@test.local', password: PASSWORD })
      .expect(429);
    expect(res.body.code).toBe('auth.tooManyAttempts');
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('validates the request body with translation keys', async () => {
    const res = await http().post('/api/auth/login').send({ identifier: '', password: '' }).expect(400);
    expect(res.body).toMatchObject({
      code: 'validation',
      issues: expect.arrayContaining([{ path: 'identifier', message: 'validation.required' }]),
    });
  });

  it('records the login in the audit log', async () => {
    const user = await createUser(ctx.prisma);
    await loginAs(ctx.app, user.email!);
    const log = await ctx.prisma.auditLog.findFirst({ where: { action: 'auth.login', actorUserId: user.id } });
    expect(log).not.toBeNull();
  });
});

describe('sessions', () => {
  it('requires a login for protected routes', async () => {
    const res = await http().get('/api/company').expect(401);
    expect(res.body.code).toBe('auth.required');
  });

  it('answers "nobody" from /me without a login, instead of an error', async () => {
    const res = await http().get('/api/auth/me').expect(200);
    expect(res.text).toBe('');
  });

  it('keeps health public', async () => {
    await http().get('/api/health').expect(200);
  });

  it('logs out and the session stops working', async () => {
    const user = await createUser(ctx.prisma);
    const agent = await loginAs(ctx.app, user.email!);
    await agent.post('/api/auth/logout').expect(204);
    await agent.get('/api/company').expect(401);
    expect(await ctx.prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it('rejects a forged or unknown session cookie', async () => {
    await http().get('/api/company').set('Cookie', 'sid=not-a-real-token').expect(401);
  });
});

describe('temporary passwords', () => {
  it('locks everything except me/logout/change-password until the password is changed', async () => {
    const company = await createCompany(ctx.prisma);
    const user = await createUser(ctx.prisma, { mustChangePassword: true });
    await addMember(ctx.prisma, user.id, company.id, 'OWNER');
    const agent = await loginAs(ctx.app, user.email!);
    const otherDevice = await loginAs(ctx.app, user.email!);

    const blocked = await agent.get('/api/company').expect(403);
    expect(blocked.body.code).toBe('auth.passwordChangeRequired');
    await agent.get('/api/auth/me').expect(200);

    await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-password' })
      .expect(204);

    await agent.get('/api/company').expect(200);
    // Other sessions are signed out when the password changes.
    await otherDevice.get('/api/company').expect(401);
    await loginAs(ctx.app, user.email!, 'a-brand-new-password');
  });

  it('rejects a wrong current password on the right field', async () => {
    const user = await createUser(ctx.prisma);
    const agent = await loginAs(ctx.app, user.email!);
    const res = await agent
      .post('/api/auth/change-password')
      .send({ currentPassword: 'not-it', newPassword: 'a-brand-new-password' })
      .expect(400);
    expect(res.body.issues).toEqual([{ path: 'currentPassword', message: 'validation.currentPasswordWrong' }]);
  });
});

describe('cross-site protection', () => {
  it('refuses data-changing requests from another site', async () => {
    const user = await createUser(ctx.prisma);
    const agent = await loginAs(ctx.app, user.email!);
    const res = await agent.post('/api/auth/logout').set('Origin', 'https://evil.example').expect(403);
    expect(res.body.code).toBe('auth.crossSite');
    await agent.get('/api/auth/me').expect(200);
  });

  it('refuses requests the browser marks as cross-site', async () => {
    await http().post('/api/auth/login').set('Sec-Fetch-Site', 'cross-site').send({}).expect(403);
  });

  it('allows requests from our own origin', async () => {
    const user = await createUser(ctx.prisma);
    const agent = await loginAs(ctx.app, user.email!);
    await agent.post('/api/auth/logout').set('Host', 'app.test').set('Origin', 'https://app.test').expect(204);
  });
});

describe('switching company', () => {
  it('switches only to companies the user is an active member of', async () => {
    const a = await createCompany(ctx.prisma, 'A');
    const b = await createCompany(ctx.prisma, 'B');
    const stranger = await createCompany(ctx.prisma, 'Stranger');
    const user = await createUser(ctx.prisma);
    await addMember(ctx.prisma, user.id, a.id, 'OWNER');
    await addMember(ctx.prisma, user.id, b.id, 'ACCOUNTANT');
    const agent = await loginAs(ctx.app, user.email!);

    await agent.post('/api/auth/switch-company').send({ companyId: b.id }).expect(204);
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.activeCompany).toMatchObject({ id: b.id, role: 'ACCOUNTANT' });

    const res = await agent.post('/api/auth/switch-company').send({ companyId: stranger.id }).expect(403);
    expect(res.body.code).toBe('company.notMember');
  });
});
