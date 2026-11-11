import { AUDIT_PAGE_SIZE } from '@puantaj/schemas';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, loginAs, memberOfNewCompany, resetDb, startApp, type TestContext } from './helpers';

let ctx: TestContext;
beforeAll(async () => (ctx = await startApp()));
afterAll(async () => ctx.app.close());
beforeEach(async () => resetDb(ctx.prisma));

async function platformAdmin() {
  const admin = await createUser(ctx.prisma, { isPlatformAdmin: true });
  return { admin, agent: await loginAs(ctx.app, admin.email!) };
}

describe('platform audit list', () => {
  it('is closed to customers, even company owners, and to anyone logged out', async () => {
    const { agent } = await memberOfNewCompany(ctx, 'OWNER');
    await agent.get('/api/platform/audit').expect(403);
    await request(ctx.app.getHttpServer()).get('/api/platform/audit').expect(401);
  });

  it('lists entries newest first with company and both names, filtered by company, person and area', async () => {
    const { admin, agent } = await platformAdmin();
    const a = await memberOfNewCompany(ctx, 'OWNER');
    const b = await memberOfNewCompany(ctx, 'OWNER');

    await a.agent.post('/api/sites').send({ name: 'Site A' }).expect(201);
    await b.agent.post('/api/sites').send({ name: 'Site B' }).expect(201);
    await agent.post(`/api/platform/users/${a.user.id}/impersonate`).expect(201);
    await agent.post('/api/sites').send({ name: 'Site A2' }).expect(201);
    await agent.post('/api/auth/impersonation/end').expect(204);
    await agent.patch(`/api/platform/users/${b.user.id}`).send({ isActive: false }).expect(204);

    const all = (await agent.get('/api/platform/audit').expect(200)).body;
    expect(all.nextCursor).toBeNull();
    const times = all.entries.map((e: { createdAt: string }) => e.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    // Sign-ins are left out unless asked for.
    expect(all.entries.some((e: { action: string }) => e.action === 'auth.login')).toBe(false);
    const withLogins = (await agent.get('/api/platform/audit?logins=true').expect(200)).body;
    expect(withLogins.entries.filter((e: { action: string }) => e.action === 'auth.login').length).toBeGreaterThanOrEqual(3);

    const impersonated = all.entries.find((e: { action: string; data: { name?: string } }) => e.action === 'site.create' && e.data.name === 'Site A2');
    expect(impersonated).toMatchObject({
      company: { id: a.company.id, name: a.company.name },
      actor: { id: a.user.id, fullName: a.user.fullName },
      impersonator: { id: admin.id, fullName: admin.fullName },
    });

    const ofA = (await agent.get(`/api/platform/audit?companyId=${a.company.id}`).expect(200)).body.entries;
    expect(ofA.length).toBeGreaterThan(0);
    expect(ofA.every((e: { company: { id: string } }) => e.company.id === a.company.id)).toBe(true);

    // A person's history: what they did, did as someone else, and what was done to their account.
    const ofAdmin = (await agent.get(`/api/platform/audit?userId=${admin.id}`).expect(200)).body.entries.map(
      (e: { action: string }) => e.action,
    );
    expect(ofAdmin).toEqual(expect.arrayContaining(['impersonation.start', 'site.create', 'impersonation.end', 'user.update']));
    const ofB = (await agent.get(`/api/platform/audit?userId=${b.user.id}`).expect(200)).body.entries;
    expect(ofB.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['site.create', 'user.update']));
    expect(ofB.some((e: { data: { name?: string } }) => e.data.name === 'Site A2')).toBe(false);

    const sites = (await agent.get('/api/platform/audit?area=site').expect(200)).body.entries;
    expect(sites.map((e: { action: string }) => e.action)).toEqual(['site.create', 'site.create', 'site.create']);
  });

  it('pages through every entry once, even entries made at the same moment', async () => {
    const { agent } = await platformAdmin();
    const { company } = await memberOfNewCompany(ctx, 'OWNER');
    const at = new Date('2026-11-01T08:00:00.000Z');
    const count = AUDIT_PAGE_SIZE * 2 + 5;
    await ctx.prisma.auditLog.createMany({
      data: Array.from({ length: count }, (_, i) => ({
        companyId: company.id,
        action: 'site.update',
        // Half share one timestamp, so the page boundary falls among equal times.
        createdAt: i % 2 ? at : new Date(at.getTime() - i * 1000),
        data: { n: i },
      })),
    });

    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `/api/platform/audit?companyId=${company.id}&area=site${cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`;
      const page: { entries: { data: { n: number } }[]; nextCursor: string | null } = (await agent.get(query).expect(200)).body;
      seen.push(...page.entries.map((e) => e.data.n));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor);

    expect(pages).toBe(3);
    expect(seen.length).toBe(count);
    expect(new Set(seen).size).toBe(count);
  });

  it('keeps entries from a time range only', async () => {
    const { agent } = await platformAdmin();
    const { company } = await memberOfNewCompany(ctx, 'OWNER');
    await ctx.prisma.auditLog.createMany({
      data: ['2026-10-31T23:59:59.000Z', '2026-11-01T00:00:00.000Z', '2026-11-30T23:59:59.000Z', '2026-12-01T00:00:00.000Z'].map(
        (createdAt) => ({ companyId: company.id, action: 'site.update', createdAt: new Date(createdAt) }),
      ),
    });
    const range = `from=${encodeURIComponent('2026-11-01T00:00:00.000Z')}&to=${encodeURIComponent('2026-12-01T00:00:00.000Z')}`;
    const entries = (await agent.get(`/api/platform/audit?companyId=${company.id}&area=site&${range}`).expect(200)).body.entries;
    expect(entries.map((e: { createdAt: string }) => e.createdAt)).toEqual(['2026-11-30T23:59:59.000Z', '2026-11-01T00:00:00.000Z']);
  });

  it('refuses a query it cannot read', async () => {
    const { agent } = await platformAdmin();
    await agent.get('/api/platform/audit?companyId=not-an-id').expect(400);
    await agent.get('/api/platform/audit?area=nothing').expect(400);
    await agent.get('/api/platform/audit?before=yesterday').expect(400);
    await agent
      .get(`/api/platform/audit?from=${encodeURIComponent('2026-12-01T00:00:00Z')}&to=${encodeURIComponent('2026-11-01T00:00:00Z')}`)
      .expect(400);
  });
});
